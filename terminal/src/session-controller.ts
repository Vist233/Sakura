// The application core. It owns the current agent session and decides what a submitted line means: a prompt, a slash command,
// a shell command, or a steering/queued message while the agent works. It has no terminal I/O; it talks to the outside only
// through the Transcript (what to show) and the Surface (what only a screen can do).
import { openAgentSession } from "./agent-session.ts";
import type { AgentSession, AgentSessionFactory, AgentSessionRequest } from "./agent-session.ts";
import type { Settings } from "./config.ts";
import { expandMentions } from "./mentions.ts";
import { isPermissionName } from "./permissions.ts";
import type { PermissionName } from "./permissions.ts";
import { allProviders, chooseProvider, listProviders } from "./providers.ts";
import { mcpReport, modelsReport, permissionsReport, statusReport } from "./reports.ts";
import { createRunDriver } from "./run-driver.ts";
import type { PendingMessage, RunDriver, RunOutcome } from "./run-driver.ts";
import { sessionLabel, titleFromPrompt } from "./session-store.ts";
import type { SessionMeta, SessionStore } from "./session-store.ts";
import { runShell } from "./shell.ts";
import type { ShellRunner } from "./shell.ts";
import { findCommand, helpMarkdown, parseSlash } from "./slash-commands.ts";
import type { CommandHost } from "./slash-commands.ts";
import { contextLeftPercent } from "./status-line.ts";
import type { StatusInfo } from "./status-line.ts";
import { CANCEL_NOTE, excerpt, replayLog } from "./transcript.ts";
import type { Transcript } from "./transcript.ts";
import type { RunResult, ThinkingLevel } from "./framework.ts";

/** What only a screen can do. The TUI implements it with painting, tests with arrays. */
export interface Surface {
  /** Something that the status line or the live area shows has changed. */
  changed(): void;
  pickSession(sessions: SessionMeta[]): Promise<SessionMeta | undefined>;
  clearScreen(): void;
  /** Puts text into the prompt (for /undo). */
  prefill(text: string): void;
  exit(): void;
}

export interface ControllerDeps {
  settings: Settings;
  cwd: string;
  home: string | undefined;
  env: Record<string, string | undefined>;
  store: SessionStore;
  transcript: Transcript;
  surface: Surface;
  openSession?: AgentSessionFactory;
  runShell?: ShellRunner;
  /** Ready-made model clients instead of a provider (scripted tests). */
  clients?: AgentSessionRequest["clients"];
}

export interface StartOptions {
  /** A session id, prefix, file path or "last". */
  resume?: string;
}

export interface Controller {
  start(options?: StartOptions): Promise<void>;
  /** `mode` is what Enter (steer) or Tab (queue) means while the agent is working. */
  submit(text: string, mode?: "steer" | "queue"): Promise<void>;
  /** Sends a prompt and waits for the run (and any follow-up of undelivered messages) to end. */
  runPrompt(text: string): Promise<RunResult>;
  cancel(): void;
  readonly driver: RunDriver;
  statusInfo(): StatusInfo;
  pending(): readonly PendingMessage[];
  current(): AgentSession | undefined;
  currentMeta(): SessionMeta | undefined;
  close(): Promise<void>;
}

interface Choice {
  provider: string;
  model: string | undefined;
  permissions: PermissionName;
  redaction: boolean;
  thinking: ThinkingLevel | undefined;
}

export function createController(deps: ControllerDeps): Controller {
  const { transcript, surface, store } = deps;
  const openSession = deps.openSession ?? openAgentSession;
  const shell = deps.runShell ?? runShell;
  const driver = createRunDriver(transcript);
  let session: AgentSession | undefined;
  let meta: SessionMeta | undefined;
  let contextPercent: number | undefined;
  let lastRunCancelled = false;
  let choice: Choice = {
    provider: deps.clients ? "scripted" : chooseProvider(deps.settings, deps.env),
    model: deps.settings.model,
    permissions: deps.settings.permissions,
    redaction: deps.settings.redaction,
    thinking: deps.settings.thinking,
  };
  driver.onChange(() => surface.changed());

  const notice = (level: "info" | "warn" | "error", text: string) => transcript.add({ kind: "notice", level, text });
  const requireSession = (): AgentSession => {
    if (!session) throw new Error("no session is open");
    return session;
  };

  // ---------- opening and closing ----------

  async function open(target: SessionMeta, next: Choice): Promise<void> {
    const opened = await openSession({
      settings: deps.settings,
      provider: next.provider,
      model: next.model,
      sessionId: target.id,
      sessionFile: store.sessionFile(target.id),
      cwd: deps.cwd,
      permissions: next.permissions,
      redaction: next.redaction,
      thinking: next.thinking,
      maxTokens: deps.settings.maxTokens,
      env: deps.env,
      ...(deps.clients ? { clients: deps.clients } : {}),
    });
    session = opened;
    choice = { ...next, model: opened.model };
    meta = await store.update(target.id, { provider: next.provider, model: opened.model });
    await refreshContext();
    surface.changed();
  }

  async function closeCurrent(options: { discardIfEmpty: boolean }): Promise<void> {
    if (!session || !meta) return;
    const closing = meta;
    await session.close();
    session = undefined;
    if (options.discardIfEmpty && closing.title === undefined) await store.remove(closing.id);
  }

  /** Reopens the current session with other settings; if that fails the old settings are restored. */
  async function reopen(patch: Partial<Choice>): Promise<boolean> {
    if (!meta) return false;
    const previous = choice;
    const target = meta;
    await closeCurrent({ discardIfEmpty: false });
    try {
      await open(target, { ...previous, ...patch });
      return true;
    } catch (error) {
      notice("error", `Could not switch: ${(error as Error).message}`);
      await open(target, previous);
      return false;
    }
  }

  async function startFresh(): Promise<void> {
    const created = await store.create({ cwd: deps.cwd, provider: choice.provider, model: choice.model ?? "" });
    await open(created, choice);
  }

  async function switchTo(target: SessionMeta): Promise<void> {
    await closeCurrent({ discardIfEmpty: true });
    const known = target.provider in allProviders(deps.settings) || deps.clients !== undefined;
    const keyed = deps.clients !== undefined || Boolean(deps.env[allProviders(deps.settings)[target.provider]?.keyEnv ?? ""]);
    const next: Choice = known && keyed && deps.settings.provider === undefined ? { ...choice, provider: target.provider, model: target.model } : choice;
    transcript.reset();
    await open(target, next);
    const entries = await requireSession().agent.log.branch();
    replayLog(transcript, entries);
    // a request that was never answered (the earlier process was cancelled or died) is dropped like a cancelled run
    const lastMessage = entries.findLast((entry) => entry.type === "message");
    lastRunCancelled = lastMessage?.type === "message" && lastMessage.message.role === "user";
    notice("info", `Resumed ${sessionLabel(meta ?? target)} (${target.id.slice(0, 8)}).`);
  }

  async function refreshContext(): Promise<void> {
    if (!session) return;
    const status = await session.agent.context();
    contextPercent = contextLeftPercent(status.free, status.window);
  }

  // ---------- running ----------

  async function runInput(input: string | undefined, options?: { compact?: boolean }): Promise<RunResult> {
    const active = requireSession();
    let next: string | undefined = input;
    let outcome: RunOutcome;
    for (;;) {
      outcome = await driver.run(active.agent, next, options?.compact ? { compact: true } : undefined);
      reportEnd(outcome.result);
      lastRunCancelled = outcome.result.reason === "cancelled";
      await refreshContext();
      if (outcome.leftover.length === 0 || outcome.result.reason !== "done") break;
      next = outcome.leftover.map((item) => item.text).join("\n\n");
      options = undefined;
    }
    if (meta) meta = await store.update(meta.id, {});
    return outcome.result;
  }

  function reportEnd(result: RunResult) {
    if (result.reason === "error") notice("error", `The run failed: ${result.error ?? "unknown error"}`);
    else if (result.reason === "paused" && result.pause === "approval") notice("warn", "The run was paused because too many actions were refused. Send a message to continue.");
  }

  // Between "a prompt was submitted" and "the driver is working" there are a few awaits; a second line typed in that
  // moment must wait for the run to exist, or it would start a second run.
  let launching: Promise<void> | undefined;

  async function startPrompt(text: string): Promise<RunResult> {
    let ready!: () => void;
    launching = new Promise<void>((resolve) => (ready = resolve));
    try {
      if (meta && meta.title === undefined) meta = await store.update(meta.id, { title: titleFromPrompt(text) });
      const mentions = await expandMentions(text, deps.cwd, deps.home);
      const running = runInput(lastRunCancelled ? `${CANCEL_NOTE}${mentions.text}` : mentions.text);
      lastRunCancelled = false; // driver.run marks the driver as working before its first await
      launching = undefined;
      ready();
      return await running;
    } finally {
      launching = undefined;
      ready();
    }
  }

  async function runShellForUser(command: string): Promise<void> {
    const result = await shell(command, deps.cwd);
    const { lines, hidden } = excerpt(result.output, 40);
    transcript.add({ kind: "shell", command, output: lines, hidden, exitCode: result.exitCode });
  }

  // ---------- the commands ----------

  const host: CommandHost = {
    print: (markdown) => transcript.add({ kind: "info", markdown }),
    fail: (text) => notice("error", text),
    help: helpMarkdown,
    async status() {
      const active = requireSession();
      return statusReport({
        sessionId: meta?.id ?? "?",
        sessionFile: store.sessionFile(meta?.id ?? "?"),
        cwd: deps.cwd,
        provider: active.provider,
        model: active.model,
        thinking: active.thinking,
        permissions: active.permissions,
        redaction: active.redaction,
        context: await active.agent.context(),
        usage: await active.agent.usage(),
        goal: await active.agent.goal(),
        working: driver.working,
      });
    },
    models: () => modelsReport(listProviders(deps.settings, deps.env), { provider: choice.provider, model: choice.model ?? "" }),
    async switchModel(provider, model) {
      if (provider === undefined) return;
      if (!(provider in allProviders(deps.settings))) return notice("error", `Unknown provider "${provider}". Known: ${Object.keys(allProviders(deps.settings)).join(", ")}.`);
      if (await reopen({ provider, model })) notice("info", `Now using ${choice.model} via ${choice.provider}. The conversation continues.`);
    },
    async permissions(name) {
      if (name === undefined) return host.print(permissionsReport(choice.permissions, choice.redaction));
      if (!isPermissionName(name)) return notice("error", `Unknown preset "${name}". Use auto, read-only, strict or full-access.`);
      if (await reopen({ permissions: name })) notice("info", `Permissions: ${name}.`);
    },
    async redaction(value) {
      if (value === undefined) return host.print(`Redaction is **${choice.redaction ? "on" : "off"}**. Use \`/redaction on\` or \`/redaction off\`.`);
      if (await reopen({ redaction: value === "on" })) notice("info", `Redaction is ${value}.`);
    },
    async compact() {
      let compacted = false;
      const stop = driver.onEvent((event) => {
        if (event.type === "compaction") compacted = true;
      });
      const result = await runInput(undefined, { compact: true });
      stop();
      if (result.reason === "done" && !compacted) notice("info", "Nothing worth summarising yet.");
    },
    async newSession() {
      await closeCurrent({ discardIfEmpty: true });
      transcript.reset();
      await startFresh();
      notice("info", `New session ${meta?.id.slice(0, 8)}.`);
    },
    async clearScreen() {
      surface.clearScreen();
      await host.newSession();
    },
    async resume(reference) {
      let target: SessionMeta | undefined;
      if (reference === undefined) {
        const all = (await store.list()).filter((item) => item.title !== undefined && item.id !== meta?.id);
        if (all.length === 0) return notice("info", "There are no earlier sessions to resume.");
        target = await surface.pickSession(all);
        if (!target) return;
      } else {
        target = await store.find(reference, reference === "last" ? { cwd: deps.cwd } : {});
        if (!target && reference === "last") target = (await store.list()).find((item) => item.title !== undefined && item.id !== meta?.id);
        if (!target) return notice("error", `No session matches "${reference}".`);
      }
      await switchTo(target);
    },
    async fork() {
      const active = requireSession();
      if (!meta || meta.title === undefined) return notice("info", "There is nothing to fork yet.");
      const child = await store.create({ cwd: deps.cwd, provider: choice.provider, model: choice.model ?? "", parentId: meta.id });
      await active.agent.fork(store.sessionFile(child.id));
      await store.update(child.id, { title: `fork: ${meta.title}` });
      const forked = (await store.get(child.id))!;
      await closeCurrent({ discardIfEmpty: false });
      await open(forked, choice);
      notice("info", `Forked into session ${forked.id.slice(0, 8)}. The original session is unchanged.`);
    },
    async undo() {
      const active = requireSession();
      const entries = await active.agent.log.branch();
      const index = entries.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
      const entry = entries[index];
      if (!entry || entry.type !== "message") return notice("info", "There is no message to undo.");
      active.agent.rewindTo(entry.parentId);
      const text = entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      notice("info", "Went back to before your last message. It is in the prompt; edit it and send it again.");
      surface.prefill(text);
      await refreshContext();
    },
    runPrompt(prompt) {
      void startPrompt(prompt).catch((error: Error) => notice("error", error.message));
    },
    async diff() {
      const result = await shell("git --no-pager diff --stat && git --no-pager diff", deps.cwd);
      const body = result.output.trim();
      host.print(body === "" ? "No uncommitted changes." : ["````diff", body.length > 20_000 ? `${body.slice(0, 20_000)}\n… (cut)` : body, "````"].join("\n"));
    },
    async goal(argument) {
      const active = requireSession();
      if (argument === undefined) {
        const goal = await active.agent.goal();
        return host.print(goal ? `Goal (${goal.status}): ${goal.objective}` : "No goal is set. Use `/goal <objective>`.");
      }
      if (argument === "clear") {
        await active.agent.clearGoal();
        return notice("info", "Goal cleared.");
      }
      await active.agent.setGoal({ objective: argument });
      notice("info", "Goal set. The next run is checked against it before the agent may stop.");
    },
    mcp: () => mcpReport(requireSession().agent.mcp),
    exit: () => surface.exit(),
  };

  // ---------- the public side ----------

  async function dispatchSlash(name: string, args: string): Promise<void> {
    const command = findCommand(name);
    if (!command) return notice("error", `Unknown command /${name}. Type /help for the list.`);
    if (driver.working && !command.duringRun) return notice("warn", `/${command.name} cannot be used while the agent is working. Press Esc to cancel the run first.`);
    try {
      await command.run(args, host);
    } catch (error) {
      notice("error", `/${command.name} failed: ${(error as Error).message}`);
    }
    surface.changed();
  }

  return {
    driver,
    async start(options = {}) {
      if (options.resume !== undefined) {
        const target = await store.find(options.resume, options.resume === "last" ? { cwd: deps.cwd } : {});
        const found = target ?? (options.resume === "last" ? (await store.list())[0] : undefined);
        if (!found) throw new Error(`No session matches "${options.resume}".`);
        await switchTo(found);
      } else await startFresh();
    },
    async submit(raw, mode = "steer") {
      const text = raw.trim();
      if (text === "") return;
      const slash = parseSlash(text);
      if (slash) return dispatchSlash(slash.name, slash.args);
      if (text.startsWith("!") && text.length > 1 && !text.startsWith("!!")) return runShellForUser(text.slice(1).trim());
      if (launching) await launching;
      if (driver.working) {
        const expanded = (await expandMentions(text, deps.cwd, deps.home)).text;
        if (mode === "queue") driver.queue(expanded);
        else driver.steer(expanded);
        return;
      }
      await startPrompt(text);
    },
    runPrompt: (text) => startPrompt(text),
    cancel: () => driver.cancel(),
    statusInfo: () => ({
      provider: choice.provider,
      model: choice.model ?? "",
      thinking: session?.thinking,
      cwd: deps.cwd,
      home: deps.home,
      contextLeftPercent: contextPercent,
      permissions: choice.permissions,
      redaction: choice.redaction,
      working: driver.working,
      queued: driver.pending().length,
    }),
    pending: () => driver.pending(),
    current: () => session,
    currentMeta: () => meta,
    async close() {
      await closeCurrent({ discardIfEmpty: true });
    },
  };
}
