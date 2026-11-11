// Many framework sessions in one process, one turn at a time per session.
import { join } from "node:path";
import type { McpServerDefinition, Settings } from "../config.ts";
import type { AgentSession, AgentSessionFactory } from "../agent-session.ts";
import { compatPresets } from "../framework.ts";
import type { Content, Event, LlmClient, LogEntry, RunResult, UserInput } from "../framework.ts";
import { PERMISSION_NAMES, PERMISSION_PRESETS } from "../permissions.ts";
import type { PermissionName } from "../permissions.ts";
import { allProviders, listProviders } from "../providers.ts";
import { titleFromPrompt } from "../session-store.ts";
import type { SessionStore } from "../session-store.ts";
import { providerFor } from "./auth.ts";
import { applyChange, buildConfigOptions, isThinkingLevel, thinkingFor } from "./config-options.ts";
import type { Choice, ProviderChoice, ThinkingLevel } from "./config-options.ts";
import type { Logger } from "./log.ts";
import { measureContext } from "../context-estimate.ts";
import { medianReplyHitRate, statusReport } from "../reports.ts";
import { saveImages } from "./attachments.ts";
import type { PromptImage } from "./content.ts";
import { snapshotPlugin } from "./snapshot-plugin.ts";
import type { Snapshots } from "./snapshot-plugin.ts";
import { safeErrorText } from "./stop-reasons.ts";
import { AcpError, ErrorCode } from "./types.ts";
import type { ConfigOption, ModeState } from "./types.ts";

export interface SessionsDeps {
  settings: Settings;
  store: SessionStore;
  env: Record<string, string | undefined>;
  open: AgentSessionFactory;
  /** Review mode of new sessions. */
  permissions: PermissionName;
  /** `full-access` (nothing is reviewed) may be picked by the client. Only when the person asked for it when starting the agent. */
  allowFullAccess: boolean;
  /** Ready-made model clients instead of a provider (tests, and the faux model hooks). */
  clients?: { agent: LlmClient; reviewer?: LlmClient } | undefined;
  log: Logger;
}

export interface TurnResult {
  result: RunResult;
  /** True when the client asked for a cancel during this turn. */
  cancelled: boolean;
}

export interface ConfigChange {
  configOptions: ConfigOption[];
  /** True when the agent was rebuilt now. False when nothing changed or the change waits for the running turn to end. */
  applied: boolean;
}

export interface Sessions {
  /** Starts a session. `mcp` are the MCP servers the client listed; they run for the life of the session, next to those of the config file. */
  create(cwd: string, mcp?: Record<string, McpServerDefinition>): Promise<string>;
  /** Opens an earlier session (from the store) on its session file; harmless when it is already open. Throws session-not-found for an unknown id. */
  load(sessionId: string, cwd: string, mcp?: Record<string, McpServerDefinition>): Promise<void>;
  /** The conversation of the session, oldest first, for the replay. */
  history(sessionId: string): Promise<readonly LogEntry[]>;
  /** Writes the images of a prompt to files next to the session and returns them as framework content. */
  saveImages(sessionId: string, images: readonly PromptImage[]): Promise<Content[]>;
  has(sessionId: string): boolean;
  /** The review mode the agent runs with now (a change waiting for the end of a turn is not counted). */
  mode(sessionId: string): PermissionName;
  /** The modes in the older form (`session/new` and `session/load` send them next to the config option). */
  modeState(sessionId: string): ModeState;
  /** The selectors for the session, with their current values (a change waiting for the end of a turn already shows). */
  configOptions(sessionId: string): ConfigOption[];
  /**
   * Sets one selector. When no turn is running the framework agent is rebuilt on the same session file at once (the history
   * stays); during a turn the change waits and is applied by `applyPending` when the turn ends.
   */
  setConfig(sessionId: string, configId: string, value: unknown): Promise<ConfigChange>;
  /** Applies a change that waited for a turn. Returns the new options when something changed, else undefined. Never throws: a failed switch keeps the old choice. */
  applyPending(sessionId: string): Promise<ConfigOption[] | undefined>;
  /** Runs one turn. `onEvent` is awaited for every event, so the client sees updates in order and a slow client slows the run down. Without input and with `compact`, the conversation is summarised. */
  run(sessionId: string, input: UserInput | undefined, onEvent: (event: Event) => Promise<void>, options?: { compact?: boolean }): Promise<TurnResult>;
  /** What a file held before the `write` with this call id ran (see `Snapshots`). */
  previous(callId: string): string | null | undefined;
  /** Drops the note about a finished call. */
  forget(callId: string): void;
  /** The goal as one line, or the hint to set one. */
  goalText(sessionId: string): Promise<string>;
  /** Sets the goal (replacing an earlier one); the next run is checked against it. Busy while a turn runs. */
  setGoal(sessionId: string, objective: string): Promise<void>;
  /** Ends the goal. Busy while a turn runs. */
  clearGoal(sessionId: string): Promise<void>;
  /** The session's directory and the model's context window. */
  info(sessionId: string): { cwd: string; contextWindow: number };
  /** How full the context is now (an estimate right after a compaction). */
  measure(sessionId: string): Promise<{ used: number; size: number }>;
  /** The `/status` table. */
  status(sessionId: string): Promise<string>;
  /** Harmless when the session is unknown or idle. */
  cancel(sessionId: string): void;
  /** Cancels running turns and closes every session. */
  closeAll(): Promise<void>;
}

interface Entry {
  session: AgentSession;
  cwd: string;
  /** MCP servers of the client, kept so a rebuilt agent has them too. */
  mcp: Record<string, McpServerDefinition>;
  titled: boolean;
  running: { cancelled: boolean; cancel(): void } | undefined;
  /** The agent is being rebuilt; no turn may start. */
  switching: boolean;
  /** What the agent was built with. */
  choice: Choice & { model: string | undefined };
  /** A change asked for during a turn. */
  pending: Choice | undefined;
}

const supportsThinking = (compat: string | undefined): boolean => {
  if (compat === undefined) return false;
  const preset = (compatPresets as Record<string, { thinkingFormat?: string }>)[compat];
  return preset?.thinkingFormat !== undefined && preset.thinkingFormat !== "none";
};

export function createSessions(deps: SessionsDeps): Sessions {
  const entries = new Map<string, Entry>();
  const snapshots: Snapshots = new Map();
  const find = (sessionId: string): Entry => {
    const entry = entries.get(sessionId);
    if (!entry) throw new AcpError(ErrorCode.sessionNotFound, `Unknown session ${sessionId}`, { sessionId });
    return entry;
  };

  /** The session, when no turn runs and the agent is not being rebuilt (the goal can change only then). */
  function idle(sessionId: string): Entry {
    const entry = find(sessionId);
    if (entry.running || entry.switching) throw new AcpError(ErrorCode.busy, "A prompt is already running in this session. Wait for it to end or cancel it.", { sessionId });
    return entry;
  }

  /** One choice per configured provider, plus the provider in use when it is not configured (the test hook's "scripted"). */
  function providerChoices(entry: Entry): ProviderChoice[] {
    const defined = allProviders(deps.settings);
    const choices: ProviderChoice[] = listProviders(deps.settings, deps.env).map((listing) => ({
      name: listing.name,
      model: listing.name === entry.choice.provider && entry.choice.model !== undefined ? entry.choice.model : listing.definition.model,
      keyEnv: listing.definition.keyEnv,
      available: listing.keyPresent || deps.clients !== undefined,
      thinking: supportsThinking(listing.definition.compat),
    }));
    if (!(entry.choice.provider in defined)) choices.unshift({ name: entry.choice.provider, model: entry.session.model, keyEnv: "", available: true, thinking: entry.session.thinking !== undefined });
    return choices;
  }

  /** What the client should see: a change that waits for the end of a turn already counts, and a model without an effort has no thinking level. */
  function viewOf(entry: Entry, choices = providerChoices(entry)): Choice {
    const wanted = entry.pending ?? entry.choice;
    return { provider: wanted.provider, thinking: thinkingFor(choices.find((choice) => choice.name === wanted.provider), wanted.thinking), permissions: wanted.permissions };
  }

  /** The review modes the client may pick. */
  const modes = (): PermissionName[] => PERMISSION_NAMES.filter((name) => name !== "full-access" || deps.allowFullAccess);

  const modeState = (entry: Entry): ModeState => {
    const current = viewOf(entry).permissions;
    return { currentModeId: current, availableModes: PERMISSION_NAMES.filter((name) => modes().includes(name) || name === current).map((name) => ({ id: name, name, description: PERMISSION_PRESETS[name].summary })) };
  };

  const optionsOf = (entry: Entry): ConfigOption[] => {
    const choices = providerChoices(entry);
    return buildConfigOptions(choices, viewOf(entry, choices), modes());
  };

  async function openFor(sessionId: string, cwd: string, choice: Choice & { model: string | undefined }, mcp: Record<string, McpServerDefinition>): Promise<AgentSession> {
    return deps.open({
      settings: Object.keys(mcp).length === 0 ? deps.settings : { ...deps.settings, mcpServers: { ...deps.settings.mcpServers, ...mcp } },
      provider: choice.provider,
      model: choice.model,
      sessionId,
      sessionFile: deps.store.sessionFile(sessionId),
      cwd,
      permissions: choice.permissions,
      redaction: deps.settings.redaction,
      thinking: choice.thinking,
      maxTokens: deps.settings.maxTokens,
      env: deps.env,
      extraPlugins: [snapshotPlugin(snapshots)],
      onRetry: (message) => deps.log.warn(`provider retry: ${safeErrorText(message)}`, { session: sessionId }),
      ...(deps.clients ? { clients: deps.clients } : {}),
    });
  }

  /** Closes the agent and opens another on the same session file; if that fails the old setup is restored. */
  async function rebuild(sessionId: string, entry: Entry, next: Choice): Promise<void> {
    const model = next.provider === entry.choice.provider ? entry.choice.model : undefined;
    const wanted = { ...next, model };
    entry.switching = true;
    try {
      await entry.session.close();
      try {
        entry.session = await openFor(sessionId, entry.cwd, wanted, entry.mcp);
      } catch (error) {
        deps.log.warn(`could not switch: ${safeErrorText(error instanceof Error ? error.message : String(error))}`, { session: sessionId });
        entry.session = await openFor(sessionId, entry.cwd, entry.choice, entry.mcp);
        throw new AcpError(ErrorCode.internalError, `Could not switch: ${safeErrorText(error instanceof Error ? error.message : String(error))}`);
      }
      entry.choice = wanted;
      await deps.store.update(sessionId, { provider: next.provider, model: entry.session.model });
      deps.log.info("session reconfigured", { session: sessionId, provider: next.provider, thinking: next.thinking ?? "none", permissions: next.permissions });
    } finally {
      entry.switching = false;
    }
  }

  /** Opens the agent for a session and registers it. */
  async function begin(sessionId: string, cwd: string, mcp: Record<string, McpServerDefinition>, provider: string, model: string | undefined, titled: boolean): Promise<void> {
    const wanted = isThinkingLevel(deps.settings.thinking) ? (deps.settings.thinking as ThinkingLevel) : undefined;
    const session = await openFor(sessionId, cwd, { provider, model, thinking: wanted, permissions: deps.permissions }, mcp);
    await deps.store.update(sessionId, { provider, model: session.model });
    entries.set(sessionId, { session, cwd, mcp, titled, running: undefined, switching: false, choice: { provider, model, thinking: session.thinking, permissions: deps.permissions }, pending: undefined });
  }

  const same = (a: Choice, b: Choice) => a.provider === b.provider && a.thinking === b.thinking && a.permissions === b.permissions;

  return {
    async create(cwd, mcp = {}) {
      // with ready-made clients (tests, the faux hooks) no key is needed; a configured provider name still shows in the selectors
      const provider = deps.clients ? (deps.settings.provider !== undefined && deps.settings.provider in allProviders(deps.settings) ? deps.settings.provider : "scripted") : providerFor(deps.settings, deps.env);
      const meta = await deps.store.create({ cwd, provider, model: deps.settings.model ?? "" });
      await begin(meta.id, cwd, mcp, provider, deps.settings.model, false);
      deps.log.info("session created", { session: meta.id, provider, permissions: deps.permissions, mcpServers: Object.keys(mcp).length });
      return meta.id;
    },
    async load(sessionId, cwd, mcp = {}) {
      if (entries.has(sessionId)) return;
      const meta = await deps.store.get(sessionId);
      if (!meta) throw new AcpError(ErrorCode.sessionNotFound, `Unknown session ${sessionId}`, { sessionId });
      // the provider the conversation used, if it can be used now; else the one a new session would get
      const known = allProviders(deps.settings);
      const usable = deps.clients !== undefined || (meta.provider in known && listProviders(deps.settings, deps.env).some((entry) => entry.name === meta.provider && entry.keyPresent));
      const provider = usable ? meta.provider : deps.clients ? "scripted" : providerFor(deps.settings, deps.env);
      await begin(sessionId, cwd, mcp, provider, usable && meta.model !== "" ? meta.model : deps.settings.model, meta.title !== undefined);
      deps.log.info("session loaded", { session: sessionId, provider, mcpServers: Object.keys(mcp).length });
    },
    async history(sessionId) {
      return find(sessionId).session.agent.log.branch();
    },
    async saveImages(sessionId, images) {
      find(sessionId);
      return saveImages(join(deps.store.root, `${sessionId}.images`), images);
    },
    has: (sessionId) => entries.has(sessionId),
    configOptions: (sessionId) => optionsOf(find(sessionId)),
    modeState: (sessionId) => modeState(find(sessionId)),
    mode: (sessionId) => find(sessionId).choice.permissions,
    async setConfig(sessionId, configId, value) {
      const entry = find(sessionId);
      const choices = providerChoices(entry);
      const view = viewOf(entry, choices);
      const next = applyChange(choices, view, configId, value, modes());
      if (same(next, view)) return { configOptions: optionsOf(entry), applied: false };
      if (entry.running || entry.switching) {
        entry.pending = same(next, viewOf({ ...entry, pending: undefined }, choices)) ? undefined : next;
        return { configOptions: optionsOf(entry), applied: false };
      }
      await rebuild(sessionId, entry, next);
      return { configOptions: optionsOf(entry), applied: true };
    },
    async applyPending(sessionId) {
      const entry = entries.get(sessionId);
      const next = entry?.pending;
      if (!entry || !next) return undefined;
      entry.pending = undefined;
      try {
        if (!same(next, viewOf(entry))) await rebuild(sessionId, entry, next);
      } catch (error) {
        deps.log.warn(`pending change not applied: ${error instanceof Error ? error.message : String(error)}`, { session: sessionId });
      }
      return optionsOf(entry);
    },
    previous: (callId) => snapshots.get(callId),
    forget: (callId) => void snapshots.delete(callId),
    async goalText(sessionId) {
      const goal = await find(sessionId).session.agent.goal();
      return goal ? `Goal (${goal.status}): ${goal.objective}` : "No goal is set. Use `/goal <objective>`.";
    },
    async setGoal(sessionId, objective) {
      const entry = idle(sessionId);
      await entry.session.agent.setGoal({ objective });
    },
    async clearGoal(sessionId) {
      await idle(sessionId).session.agent.clearGoal();
    },
    info(sessionId) {
      const entry = find(sessionId);
      return { cwd: entry.cwd, contextWindow: entry.session.contextWindow };
    },
    async measure(sessionId) {
      const entry = find(sessionId);
      const measured = await measureContext(entry.session.agent);
      return { used: measured.tokens, size: measured.window };
    },
    async status(sessionId) {
      const entry = find(sessionId);
      const { agent } = entry.session;
      const measured = await measureContext(agent);
      const context = await agent.context();
      return statusReport({
        sessionId,
        sessionFile: deps.store.sessionFile(sessionId),
        cwd: entry.cwd,
        provider: entry.session.provider,
        model: entry.session.model,
        thinking: entry.session.thinking,
        permissions: entry.session.permissions,
        redaction: entry.session.redaction,
        context: { ...context, tokens: measured.tokens, free: Math.max(0, measured.window - measured.tokens) },
        contextEstimated: measured.estimated,
        usage: await agent.usage(),
        medianHitRate: medianReplyHitRate(await agent.log.branch()),
        goal: await agent.goal(),
        working: entry.running !== undefined,
        idleCompaction: "off",
      });
    },
    async run(sessionId, input, onEvent, options) {
      const entry = find(sessionId);
      // checked and set before the first await: two prompts cannot both pass
      if (entry.running || entry.switching) throw new AcpError(ErrorCode.busy, "A prompt is already running in this session. Wait for it to end or cancel it.", { sessionId });
      const handle = entry.session.agent.run(input, options?.compact ? { compact: true } : undefined);
      const running = {
        cancelled: false,
        cancel() {
          running.cancelled = true;
          handle.cancel();
        },
      };
      entry.running = running;
      try {
        if (!entry.titled) {
          entry.titled = true;
          const text = typeof input === "string" ? input : (input ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
          if (text.trim() !== "") await deps.store.update(sessionId, { title: titleFromPrompt(text) });
        }
        for await (const event of handle.events) await onEvent(event);
        return { result: await handle.result, cancelled: running.cancelled };
      } catch (error) {
        handle.cancel();
        throw error;
      } finally {
        entry.running = undefined;
        await deps.store.update(sessionId, {}).catch(() => undefined);
      }
    },
    cancel(sessionId) {
      entries.get(sessionId)?.running?.cancel();
    },
    async closeAll() {
      for (const entry of entries.values()) entry.running?.cancel();
      const all = [...entries.values()];
      entries.clear();
      await Promise.allSettled(all.map((entry) => entry.session.close()));
    },
  };

}
