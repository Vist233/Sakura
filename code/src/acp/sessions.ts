// Many framework sessions in one process, one turn at a time per session.
import type { Settings } from "../config.ts";
import type { AgentSessionFactory, AgentSession } from "../agent-session.ts";
import type { Event, LlmClient, RunResult } from "../framework.ts";
import type { PermissionName } from "../permissions.ts";
import { providerFor } from "./auth.ts";
import { titleFromPrompt } from "../session-store.ts";
import type { SessionStore } from "../session-store.ts";
import type { Logger } from "./log.ts";
import { safeErrorText } from "./stop-reasons.ts";
import { AcpError, ErrorCode } from "./types.ts";

export interface SessionsDeps {
  settings: Settings;
  store: SessionStore;
  env: Record<string, string | undefined>;
  open: AgentSessionFactory;
  /** Review mode of new sessions. */
  permissions: PermissionName;
  /** Ready-made model clients instead of a provider (tests, and the faux model hooks). */
  clients?: { agent: LlmClient; reviewer?: LlmClient } | undefined;
  log: Logger;
}

export interface TurnResult {
  result: RunResult;
  /** True when the client asked for a cancel during this turn. */
  cancelled: boolean;
}

export interface Sessions {
  create(cwd: string): Promise<string>;
  has(sessionId: string): boolean;
  /** Runs one turn. `onEvent` is awaited for every event, so the client sees updates in order and a slow client slows the run down. */
  run(sessionId: string, input: string, onEvent: (event: Event) => Promise<void>): Promise<TurnResult>;
  /** Harmless when the session is unknown or idle. */
  cancel(sessionId: string): void;
  /** Cancels running turns and closes every session. */
  closeAll(): Promise<void>;
}

interface Entry {
  session: AgentSession;
  titled: boolean;
  running: { cancelled: boolean; cancel(): void } | undefined;
}

export function createSessions(deps: SessionsDeps): Sessions {
  const entries = new Map<string, Entry>();
  const find = (sessionId: string): Entry => {
    const entry = entries.get(sessionId);
    if (!entry) throw new AcpError(ErrorCode.sessionNotFound, `Unknown session ${sessionId}`, { sessionId });
    return entry;
  };

  return {
    async create(cwd) {
      const provider = deps.clients ? "scripted" : providerFor(deps.settings, deps.env);
      const meta = await deps.store.create({ cwd, provider, model: deps.settings.model ?? "" });
      const session = await deps.open({
        settings: deps.settings,
        provider,
        model: deps.settings.model,
        sessionId: meta.id,
        sessionFile: deps.store.sessionFile(meta.id),
        cwd,
        permissions: deps.permissions,
        redaction: deps.settings.redaction,
        thinking: deps.settings.thinking,
        maxTokens: deps.settings.maxTokens,
        env: deps.env,
        onRetry: (message) => deps.log.warn(`provider retry: ${safeErrorText(message)}`, { session: meta.id }),
        ...(deps.clients ? { clients: deps.clients } : {}),
      });
      await deps.store.update(meta.id, { provider, model: session.model });
      entries.set(meta.id, { session, titled: false, running: undefined });
      deps.log.info("session created", { session: meta.id, provider, permissions: deps.permissions });
      return meta.id;
    },
    has: (sessionId) => entries.has(sessionId),
    async run(sessionId, input, onEvent) {
      const entry = find(sessionId);
      // checked and set before the first await: two prompts cannot both pass
      if (entry.running) throw new AcpError(ErrorCode.busy, "A prompt is already running in this session. Wait for it to end or cancel it.", { sessionId });
      const handle = entry.session.agent.run(input);
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
          await deps.store.update(sessionId, { title: titleFromPrompt(input) });
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
