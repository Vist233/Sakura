// What the slash commands do, for the controller: reports, switching the model or the permissions, new, resumed and forked sessions, undo, diff, goals and
// the schedule. It owns no state of its own; the controller gives it what it needs through `HostContext`.
import type { AgentSession } from "./agent-session.ts";
import type { ControllerDeps } from "./session-controller.ts";
import { isPermissionName } from "./permissions.ts";
import type { PermissionName } from "./permissions.ts";
import { allProviders, listProviders } from "./providers.ts";
import { mcpReport, medianReplyHitRate, modelsReport, permissionsReport, statusReport } from "./reports.ts";
import type { RunDriver } from "./run-driver.ts";
import type { SessionMeta } from "./session-store.ts";
import type { ShellRunner } from "./shell.ts";
import { helpMarkdown } from "./slash-commands.ts";
import type { CommandHost } from "./slash-commands.ts";
import { scheduleCommand, scheduleSummary } from "./schedule.ts";
import type { createScheduler } from "./schedule.ts";
import type { ContextStatus, RunResult, ThinkingLevel, UserInput } from "./framework.ts";

/** The provider, model, permissions, redaction and thinking level the current session was opened with. */
export interface Choice {
  provider: string;
  model: string | undefined;
  permissions: PermissionName;
  redaction: boolean;
  thinking: ThinkingLevel | undefined;
}

/** What the commands need from the controller. */
export interface HostContext {
  deps: ControllerDeps;
  shell: ShellRunner;
  driver: RunDriver;
  scheduler: ReturnType<typeof createScheduler>;
  notice(level: "info" | "warn" | "error", text: string): void;
  requireSession(): AgentSession;
  meta(): SessionMeta | undefined;
  setMeta(meta: SessionMeta): void;
  choice(): Choice;
  clearPendingPermissions(): void;
  reopen(patch: Partial<Choice>): Promise<boolean>;
  closeCurrent(options: { discardIfEmpty: boolean }): Promise<void>;
  open(target: SessionMeta, choice: Choice): Promise<void>;
  startFresh(): Promise<void>;
  switchTo(target: SessionMeta): Promise<void>;
  refreshContext(): Promise<void>;
  runInput(input: UserInput | undefined, options?: { compact?: boolean }): Promise<RunResult>;
  startPrompt(text: string): Promise<RunResult>;
  statusContext(active: AgentSession): Promise<{ context: ContextStatus; contextEstimated: boolean }>;
}

// tracked changes against HEAD (or the index in a repository without commits), then every untracked file as an addition
const DIFF_COMMAND =
  'git --no-pager diff HEAD 2>/dev/null || git --no-pager diff; git ls-files --others --exclude-standard | while read -r f; do git --no-pager diff --no-index -- /dev/null "$f"; done';

export function createCommandHost(ctx: HostContext): CommandHost {
  const { deps } = ctx;
  const { store, transcript, surface } = deps;
  const { shell, driver, scheduler, notice, requireSession, reopen, closeCurrent, open, startFresh, switchTo, refreshContext, runInput, startPrompt, statusContext } = ctx;
  const host: CommandHost = {
    print: (markdown) => transcript.add({ kind: "info", markdown }),
    fail: (text) => notice("error", text),
    help: helpMarkdown,
    async status() {
      const active = requireSession();
      return statusReport({
        sessionId: ctx.meta()?.id ?? "?",
        sessionFile: store.sessionFile(ctx.meta()?.id ?? "?"),
        cwd: deps.cwd,
        provider: active.provider,
        model: active.model,
        thinking: active.thinking,
        permissions: active.permissions,
        redaction: active.redaction,
        ...(await statusContext(active)),
        usage: await active.agent.usage(),
        medianHitRate: medianReplyHitRate(await active.agent.log.branch()),
        goal: await active.agent.goal(),
        working: driver.working,
        scheduled: scheduleSummary(scheduler),
        idleCompaction: deps.settings.autoCompactIdle ? `after ${deps.settings.cacheTtlMinutes} min idle, from ${deps.settings.autoCompactMinTokens.toLocaleString("en-US")} tokens` : "off",
      });
    },
    models: () => modelsReport(listProviders(deps.settings, deps.env), { provider: ctx.choice().provider, model: ctx.choice().model ?? "" }),
    async switchModel(provider, model) {
      if (provider === undefined) return;
      if (!(provider in allProviders(deps.settings))) return notice("error", `Unknown provider "${provider}". Known: ${Object.keys(allProviders(deps.settings)).join(", ")}.`);
      if (await reopen({ provider, model })) notice("info", `Now using ${ctx.choice().model} via ${ctx.choice().provider}. The conversation continues.`);
    },
    async permissions(name) {
      if (name === undefined) return host.print(permissionsReport(ctx.choice().permissions, ctx.choice().redaction));
      if (!isPermissionName(name)) return notice("error", `Unknown preset "${name}". Use auto, read-only, strict or full-access.`);
      ctx.clearPendingPermissions();
      if (await reopen({ permissions: name })) notice("info", `Permissions: ${name}.`);
    },
    async redaction(value) {
      if (value === undefined) return host.print(`Redaction is **${ctx.choice().redaction ? "on" : "off"}**. Use \`/redaction on\` or \`/redaction off\`.`);
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
      notice("info", `New session ${ctx.meta()?.id.slice(0, 8)}.`);
    },
    async clearScreen() {
      surface.clearScreen();
      await host.newSession();
    },
    async resume(reference) {
      let target: SessionMeta | undefined;
      if (reference === undefined) {
        const all = (await store.list()).filter((item) => item.title !== undefined && item.id !== ctx.meta()?.id);
        if (all.length === 0) return notice("info", "There are no earlier sessions to resume.");
        target = await surface.pickSession(all);
        if (!target) return;
      } else {
        target = await store.find(reference, reference === "last" ? { cwd: deps.cwd } : {});
        if (!target && reference === "last") target = (await store.list()).find((item) => item.title !== undefined && item.id !== ctx.meta()?.id);
        if (!target) return notice("error", `No session matches "${reference}".`);
      }
      await switchTo(target);
    },
    async fork() {
      const active = requireSession();
      const meta = ctx.meta();
      if (!meta || meta.title === undefined) return notice("info", "There is nothing to fork yet.");
      const child = await store.create({ cwd: deps.cwd, provider: ctx.choice().provider, model: ctx.choice().model ?? "", parentId: meta.id });
      await active.agent.fork(store.sessionFile(child.id));
      await store.update(child.id, { title: `fork: ${meta.title}` });
      const forked = (await store.get(child.id))!;
      await closeCurrent({ discardIfEmpty: false });
      await open(forked, ctx.choice());
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
    async rename(title) {
      const meta = ctx.meta();
      if (!meta) return;
      ctx.setMeta(await store.update(meta.id, { title }));
      notice("info", `Session renamed to "${title}".`);
    },
    runPrompt(prompt) {
      void startPrompt(prompt).catch((error: Error) => notice("error", error.message));
    },
    async diff() {
      const result = await shell(DIFF_COMMAND, deps.cwd);
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
      notice("info", "Goal set. Working on it now; it is checked before the agent may stop.");
      await startPrompt(argument);
    },
    mcp: () => mcpReport(requireSession().agent.mcp),
    schedule(name, args) {
      const reply = scheduleCommand(scheduler, name, args);
      if (reply.error) notice("error", reply.text);
      else host.print(reply.text);
    },
    exit: () => surface.exit(),
  };
  return host;
}
