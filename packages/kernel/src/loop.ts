import { createChannel } from "./channel.ts";
import { contextTokens, defaultCompaction, planCompaction, shouldCompact } from "./compaction.ts";
import type { CompactionConfig } from "./compaction.ts";
import { BLOCKED_AFTER, describeRemaining, judgeChecklist, newGoal, parseChecklist } from "./goal.ts";
import { defaultPrompts, fill } from "./prompts.ts";
import type { Prompts } from "./prompts.ts";
import { createHookSet } from "./hooks.ts";
import { diffSystem, renderSystem, replaySystem } from "./system.ts";
import type { SystemState } from "./system.ts";
import type { HookSet } from "./hooks.ts";
import { ProviderError } from "./types.ts";
import type {
  Content,
  Environment,
  Event,
  EventTransform,
  LlmClient,
  LlmEvent,
  LlmRequest,
  Log,
  LogEntry,
  Message,
  PauseReason,
  Plugin,
  RunEndReason,
  StopReason,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResult,
  Usage,
  UsageTotals,
} from "./types.ts";

export interface KernelConfig {
  llm: LlmClient;
  env: Environment;
  system: string;
  tools?: Tool[];
  plugins?: Plugin[];
  maxTokens?: number;
  thinking?: ThinkingLevel;
  now?: () => number;
  /** Compaction is on by default; `false` turns it off. */
  compaction?: false | Partial<CompactionConfig>;
  /** Opens a goal the first time a log is run. The agent is checked against it before it may stop. */
  goal?: { objective: string; verify?: string };
  prompts?: Partial<Prompts>;
  /** Called whenever a tool or plugin reports a change, even when no run is active, so the caller can decide to start one. */
  onSignal?(log: Log, text: string, options?: { wake?: boolean }): void;
}

export type UserInput = string | Content[];

export interface RunResult {
  reason: RunEndReason;
  pause?: PauseReason;
  error?: string;
}

export interface RunHandle {
  events: AsyncIterable<Event>;
  result: Promise<RunResult>;
  /** Handled when the agent would otherwise stop. */
  queue(text: string): void;
  /** Handled before the next model request. */
  steer(text: string): void;
  cancel(): void;
}

export interface Kernel {
  /**
   * The single entry for starting, resuming and following up. The tail of the log decides what happens:
   * unanswered user input or tool results go to the model, a finished reply ends the run immediately.
   */
  run(log: Log, input?: UserInput): RunHandle;
  /** What the agent has not been told yet, and the background work it is still waiting for. Lets a host wake an agent that went quiet. */
  pending(log: Log): { signals: string[]; watching: string[] };
}

const CANCELLED_RESULT = "The run was cancelled before this tool finished.";
const INTERRUPTED_RESULT = "This tool was interrupted and may have partially run. Check the current state before deciding what to do.";
const TRUNCATED_RESULT = "Your output was cut off before this tool call was complete, so it was not run. Split the work into smaller parts and try again.";

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function toContent(input: UserInput): Content[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}

/** Runs the model's events through the transforms that request hooks asked for, in order. */
async function* throughTransforms(transforms: readonly EventTransform[], source: AsyncIterable<LlmEvent>): AsyncGenerator<LlmEvent> {
  const run = (events: LlmEvent[], from: number): LlmEvent[] => transforms.slice(from).reduce((current, transform) => current.flatMap((event) => transform.push(event)), events);
  for await (const event of source) yield* run([event], 0);
  for (const [index, transform] of transforms.entries()) yield* run(transform.flush(), index + 1);
}

function usageTotals(branch: readonly LogEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const entry of branch) {
    const usage = entry.type === "message" ? entry.message.usage : entry.type === "usage" ? entry.usage : undefined;
    if (entry.type === "message" && entry.message.role === "assistant") totals.turns++;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
  }
  return totals;
}

function toolCallsOf(message: Message): ToolCall[] {
  return message.content.flatMap((part) => (part.type === "tool_call" ? [{ id: part.id, name: part.name, args: part.args }] : []));
}

interface ModelTurn {
  message: Message;
  calls: ToolCall[];
  truncated: { id: string; name: string } | undefined;
}

export function createKernel(config: KernelConfig): Kernel {
  const now = config.now ?? Date.now;
  const prompts: Prompts = { ...defaultPrompts, ...config.prompts };
  // a caller who gives `reserveTokens` (and no share) gets exactly that, as before; the share is for the default
  const given = config.compaction === false ? undefined : config.compaction;
  const compactionConfig: CompactionConfig | undefined =
    config.compaction === false ? undefined : { ...defaultCompaction, ...(given?.reserveTokens !== undefined && given.reserveFraction === undefined ? { reserveFraction: 0 } : {}), ...given };
  const activeLogs = new WeakSet<Log>();
  // Plugins are set up once. Failures of their handlers are reported to the runs that are active.
  const failureReporters = new Set<(plugin: string, hook: string, error: unknown) => void>();
  const pluginEmitters = new Set<(plugin: string, data: unknown) => void>();
  // Changes that tools reported and the agent has not been told about yet, kept per conversation across runs.
  const pendingSignals = new WeakMap<Log, string[]>();
  const watchedWork = new WeakMap<Log, Set<{ label: string }>>();
  const hooks: HookSet = createHookSet(
    config.plugins ?? [],
    config.tools ?? [],
    (plugin, hook, error) => {
      for (const report of failureReporters) report(plugin, hook, error);
    },
    (plugin, data) => {
      for (const send of pluginEmitters) send(plugin, data);
    },
  );
  const toolByName = new Map(hooks.tools.map((tool) => [tool.name, tool]));

  function run(log: Log, input?: UserInput): RunHandle {
    if (activeLogs.has(log)) throw new Error("this log already has an active run");
    activeLogs.add(log);

    const channel = createChannel<Event>();
    const controller = new AbortController();
    const steered: string[] = [];
    const queued: string[] = [];
    let cancelled = false;
    let finished = false;

    // A failure inside an event observer is shown to the caller only; sending it to the observers again would loop.
    const reportFailure = (plugin: string, hook: string, error: unknown) => emit({ type: "plugin", name: plugin, data: { hook, error: String(error) } }, hook !== "event");
    failureReporters.add(reportFailure);
    const sendPluginEvent = (plugin: string, data: unknown) => emit({ type: "plugin", name: plugin, data });
    pluginEmitters.add(sendPluginEvent);

    function emit(event: Event, notifyObservers = true): void {
      channel.push(event);
      if (notifyObservers) hooks.event(event);
    }

    async function appendMessage(message: Message): Promise<LogEntry> {
      return log.append({ type: "message", message });
    }

    function userMessage(content: Content[]): Message {
      return { role: "user", content, ts: now() };
    }

    function toolMessage(call: ToolCall, result: ToolResult): Message {
      return {
        role: "tool",
        content: result.content,
        ts: now(),
        toolCallId: call.id,
        toolName: call.name,
        ...(result.isError ? { isError: true } : {}),
      };
    }

    // ----- system prompt and tool list, recorded in the log -----

    let systemState: SystemState = { sections: {}, tools: [] };

    /** Writes a patch when the configuration differs from what the log says, then keeps the log's version for the requests. */
    async function syncSystem(): Promise<void> {
      const desired = { system: config.system, tools: hooks.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) };
      const patch = diffSystem(replaySystem(await log.branch()), desired);
      if (patch) await log.append({ type: "system_patch", ...patch });
      systemState = replaySystem(await log.branch());
    }

    // ----- signals -----

    const reportChange = (text: string, wake?: boolean): void => {
      const list = pendingSignals.get(log) ?? [];
      list.push(text);
      pendingSignals.set(log, list);
      config.onSignal?.(log, text, wake === undefined ? undefined : { wake });
      if (!finished) emit({ type: "signal", text });
    };

    const watchWork = (label: string, options?: { wake?: boolean }): ((text: string, ending?: { wake?: boolean }) => void) => {
      const entry = { label };
      const set = watchedWork.get(log) ?? new Set();
      set.add(entry);
      watchedWork.set(log, set);
      return (text, ending) => {
        if (set.delete(entry)) reportChange(text, ending?.wake ?? options?.wake);
      };
    };

    /** Tells the agent what changed, as one message in a fixed form. */
    async function deliverSignals(): Promise<boolean> {
      const list = pendingSignals.get(log);
      if (!list || list.length === 0) return false;
      pendingSignals.set(log, []);
      const body = `Notice: since your last turn, these changes happened (details are not included; check with your tools if relevant):\n${list.map((text) => `- ${text}`).join("\n")}`;
      await log.append({ type: "custom_message", customType: "signal", content: [{ type: "text", text: body }] });
      return true;
    }

    // ----- tools -----

    async function executeCall(call: ToolCall): Promise<ToolResult> {
      const tool = toolByName.get(call.name);
      if (!tool) return errorResult(`Tool '${call.name}' is not available.`);
      const { decision, args } = await hooks.toolBefore(call, { log, env: config.env, signal: controller.signal, tool: (name) => toolByName.get(name) });
      if (decision.kind === "deny") return errorResult(`Not allowed: ${decision.reason}`);

      emit({ type: "tool_start", call: { ...call, args } });
      if (tool.replay === "never" && tool.effect !== "read") {
        await log.append({ type: "tool_started", toolCallId: call.id, toolName: call.name });
      }
      const base = async (): Promise<ToolResult> => {
        try {
          return await tool.execute(args, { env: config.env, signal: controller.signal, callId: call.id, log, notify: reportChange, watch: watchWork });
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      };
      return hooks.toolAfter(call, await hooks.toolRun({ ...call, args }, base));
    }

    async function finishCall(call: ToolCall): Promise<void> {
      const result = await executeCall(call);
      await appendMessage(toolMessage(call, result));
      emit({ type: "tool_end", call, result });
    }

    /** Runs the calls of one assistant message: read-only tools in parallel, everything else one at a time. */
    async function executeCalls(calls: ToolCall[]): Promise<void> {
      let parallel: Promise<void>[] = [];
      for (const call of calls) {
        const tool = toolByName.get(call.name);
        const isParallel = (tool?.executionMode ?? (tool?.effect === "read" ? "parallel" : "serial")) === "parallel";
        if (isParallel) {
          parallel.push(finishCall(call));
          continue;
        }
        await Promise.all(parallel);
        parallel = [];
        if (controller.signal.aborted) break;
        await finishCall(call);
      }
      await Promise.all(parallel);
    }

    /** After a cancel or a crash: give every call without a result an error result so the log stays valid. */
    async function closeOpenCalls(text: string): Promise<void> {
      const branch = await log.branch();
      const answered = new Set(branch.flatMap((entry) => (entry.type === "message" && entry.message.toolCallId ? [entry.message.toolCallId] : [])));
      for (const entry of branch) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        for (const call of toolCallsOf(entry.message)) {
          if (answered.has(call.id)) continue;
          await appendMessage(toolMessage(call, errorResult(text)));
          answered.add(call.id);
        }
      }
    }

    /** Resume after a crash: finish the tool calls of the last assistant message that have no result. */
    async function recover(): Promise<void> {
      const branch = await log.branch();
      const answered = new Set(branch.flatMap((entry) => (entry.type === "message" && entry.message.toolCallId ? [entry.message.toolCallId] : [])));
      const started = new Set(branch.flatMap((entry) => (entry.type === "tool_started" ? [entry.toolCallId] : [])));
      const lastAssistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (lastAssistant?.type !== "message") return;
      const open = toolCallsOf(lastAssistant.message).filter((call) => !answered.has(call.id));
      const rerun: ToolCall[] = [];
      for (const call of open) {
        const tool = toolByName.get(call.name);
        if (tool?.replay === "never" && started.has(call.id)) {
          await appendMessage(toolMessage(call, errorResult(INTERRUPTED_RESULT)));
        } else {
          rerun.push(call);
        }
      }
      await executeCalls(rerun);
    }

    // ----- model -----

    async function callModel(messages: Message[]): Promise<ModelTurn> {
      let request: LlmRequest = {
        system: renderSystem(systemState),
        messages: hooks.context(messages),
        tools: systemState.tools,
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
      };
      const prepared = hooks.request(request);
      request = prepared.request;

      let text = "";
      const providerParts: Content[] = [];
      const calls: ToolCall[] = [];
      let truncated: ModelTurn["truncated"];
      let usage: Usage | undefined;
      let stop: StopReason = "stop";

      for await (const event of throughTransforms(prepared.transforms, config.llm.stream(request, controller.signal))) {
        if (event.type === "text_delta") {
          text += event.delta;
          emit({ type: "message_update", delta: { type: "text", text: event.delta } });
        } else if (event.type === "provider") {
          providerParts.push({ type: "provider", vendor: event.vendor, data: event.data });
        } else if (event.type === "tool_call") {
          calls.push(event.call);
        } else if (event.type === "tool_call_truncated") {
          truncated = { id: event.id, name: event.name };
        } else if (event.type === "usage") {
          usage = event.usage;
        } else if (event.type === "restart") {
          text = "";
          providerParts.length = 0;
          calls.length = 0;
          truncated = undefined;
          usage = undefined;
          stop = "stop";
          emit({ type: "message_reset" });
        } else if (event.type === "done") {
          stop = event.stop;
        }
      }

      const content: Content[] = [...providerParts];
      if (text) content.push({ type: "text", text });
      for (const call of calls) content.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
      if (truncated) content.push({ type: "tool_call", id: truncated.id, name: truncated.name, args: {} });
      const message: Message = { role: "assistant", content, ts: now(), stop, ...(usage ? { usage } : {}) };
      return { message, calls, truncated };
    }

    // ----- side requests: compaction and the goal check -----

    /** Asks the model something about the conversation without letting it act: tool calls are ignored. */
    async function ask(messages: Message[], prompt: string): Promise<{ text: string; usage: Usage | undefined }> {
      let request: LlmRequest = {
        system: renderSystem(systemState),
        messages: hooks.context([...messages, userMessage([{ type: "text", text: prompt }])]),
        tools: systemState.tools,
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      };
      const prepared = hooks.request(request);
      request = prepared.request;
      let text = "";
      let usage: Usage | undefined;
      for await (const event of throughTransforms(prepared.transforms, config.llm.stream(request, controller.signal))) {
        if (event.type === "text_delta") text += event.delta;
        else if (event.type === "usage") usage = event.usage;
        else if (event.type === "restart") {
          text = "";
          usage = undefined;
        }
      }
      return { text, usage };
    }

    /** Replaces old history with a summary. Returns false when nothing was compacted. */
    async function compact(): Promise<boolean> {
      if (!compactionConfig) return false;
      const branch = await log.branch();
      const plan = planCompaction(branch, compactionConfig);
      if (!plan) return false;
      const previous = [...branch].reverse().find((entry) => entry.type === "compaction");
      const before = await log.project(plan.firstKeptEntryId);
      const tokensBefore = contextTokens(await log.project());
      const prompt = previous?.type === "compaction" ? fill(prompts.compactUpdate, { previous_summary: previous.summary }) : prompts.compactFirst;
      const { text, usage } = await ask(before, prompt);
      if (text.trim() === "") return false;
      if (usage) await log.append({ type: "usage", kind: "compaction", usage });
      await log.append({ type: "compaction", summary: text.trim(), firstKeptEntryId: plan.firstKeptEntryId, tokensBefore });
      emit({ type: "compaction", tokensBefore });
      for (const plugin of config.plugins ?? []) {
        try {
          await plugin.afterCompaction?.({ log, env: config.env });
        } catch (error) {
          reportFailure(plugin.name, "afterCompaction", error);
        }
      }
      return true;
    }

    /** A failed compaction must not stop the run; the caller carries on with the full context. */
    async function tryCompact(): Promise<boolean> {
      try {
        return await compact();
      } catch (error) {
        if (cancelled || isAbort(error)) throw error;
        emit({ type: "plugin", name: "compaction", data: { error: String(error) } });
        return false;
      }
    }

    function currentGoal(branch: readonly LogEntry[]) {
      const entry = [...branch].reverse().find((candidate) => candidate.type === "goal");
      return entry?.type === "goal" ? entry.goal : undefined;
    }

    async function openGoal(): Promise<void> {
      if (!config.goal || currentGoal(await log.branch())) return;
      const goal = newGoal(config.goal.objective, config.goal.verify);
      await log.append({ type: "goal", goal });
      await log.append({
        type: "custom_message",
        customType: "goal",
        pinned: true,
        content: [{ type: "text", text: fill(prompts.goalStatement, { objective: goal.objective }) }],
      });
    }

    /** Runs when the agent wants to stop. Returns what the run should do next. */
    async function wrapUp(): Promise<"stop" | "continue" | "blocked"> {
      const goal = currentGoal(await log.branch());
      if (goal?.status !== "active") return "stop";
      const { text, usage } = await ask(await log.project(), fill(prompts.goalWrapUp, { objective: goal.objective }));
      if (usage) await log.append({ type: "usage", kind: "goal_check", usage });
      const items = parseChecklist(text);
      const verdict = judgeChecklist(items);
      await log.append({ type: "custom", customType: "goal_check", data: { verdict: verdict.kind, items } });

      if (verdict.kind === "complete") {
        if (goal.verify) {
          const check = await config.env.exec(goal.verify, { signal: controller.signal });
          if (check.exitCode !== 0) {
            await appendMessage(userMessage([{ type: "text", text: fill(prompts.goalVerifyFailed, { output: check.output.slice(-4000) }) }]));
            return "continue";
          }
        }
        await log.append({ type: "goal", goal: { ...goal, status: "complete", humanStreak: 0 } });
        emit({ type: "goal", status: "complete" });
        return "stop";
      }
      if (verdict.kind === "continue") {
        if (goal.humanStreak !== 0) await log.append({ type: "goal", goal: { ...goal, humanStreak: 0 } });
        await appendMessage(userMessage([{ type: "text", text: fill(prompts.goalContinue, { remaining: describeRemaining(verdict.remaining) }) }]));
        return "continue";
      }
      const streak = goal.humanStreak + 1;
      if (streak >= BLOCKED_AFTER) {
        await log.append({ type: "goal", goal: { ...goal, status: "blocked", humanStreak: streak } });
        emit({ type: "goal", status: "blocked" });
        await log.append({ type: "paused", reason: "blocked" });
        emit({ type: "paused", reason: "blocked" });
        return "blocked";
      }
      await log.append({ type: "goal", goal: { ...goal, humanStreak: streak } });
      await appendMessage(userMessage([{ type: "text", text: fill(prompts.goalNeedsHuman, { remaining: describeRemaining(verdict.remaining) }) }]));
      return "continue";
    }

    // ----- the run -----

    async function drive(): Promise<RunResult> {
      emit({ type: "run_start" });
      await syncSystem();
      for (const plugin of config.plugins ?? []) await plugin.prepare?.({ log, env: config.env });
      await recover();
      await openGoal();
      if (input !== undefined) {
        await deliverSignals();
        const message = userMessage(toContent(input));
        await appendMessage(message);
        emit({ type: "message_end", message });
      } else {
        // a host that woke the agent because background work ended has no new input: the notice is the news
        await deliverSignals();
      }

      let overflowRetried = false;
      while (true) {
        if (cancelled) return { reason: "cancelled" };

        for (const text of steered.splice(0)) await appendMessage(userMessage([{ type: "text", text }]));
        let messages = await log.project();
        if (compactionConfig && shouldCompact(messages, config.llm.model.contextWindow, compactionConfig) && (await tryCompact())) {
          messages = await log.project();
        }
        const last = messages.at(-1);

        if (!last || last.role === "assistant") {
          if (last?.role === "assistant" && !last.content.some((part) => part.type === "tool_call")) {
            const decision = await wrapUp();
            if (decision === "blocked") return { reason: "paused", pause: "blocked" };
            if (decision === "continue") continue;
          }
          const next = queued.shift();
          if (next === undefined) return { reason: "done" };
          await appendMessage(userMessage([{ type: "text", text: next }]));
          continue;
        }

        if (await deliverSignals()) messages = await log.project();
        emit({ type: "turn_start" });
        let turn: ModelTurn;
        try {
          turn = await callModel(messages);
        } catch (error) {
          if (cancelled || isAbort(error)) return { reason: "cancelled" };
          if (error instanceof ProviderError) {
            if (error.kind === "context_overflow" && !overflowRetried && (await tryCompact())) {
              overflowRetried = true;
              continue;
            }
            const pause = hooks.error(error);
            if (pause) {
              await log.append({ type: "paused", reason: pause });
              emit({ type: "paused", reason: pause });
              return { reason: "paused", pause };
            }
            return { reason: "error", error: error.message };
          }
          throw error;
        }

        overflowRetried = false;
        emit({ type: "message_start", message: turn.message });
        await appendMessage(turn.message);
        emit({ type: "message_end", message: turn.message });

        if (turn.truncated) {
          const call = { id: turn.truncated.id, name: turn.truncated.name, args: {} };
          await executeCalls(turn.calls);
          await appendMessage(toolMessage(call, errorResult(TRUNCATED_RESULT)));
        } else {
          await executeCalls(turn.calls);
        }
        if (cancelled) {
          await closeOpenCalls(CANCELLED_RESULT);
          return { reason: "cancelled" };
        }

        const outcome = hooks.turnEnd({
          log,
          messages: await log.project(),
          toolCallCount: turn.calls.length + (turn.truncated ? 1 : 0),
          totals: usageTotals(await log.branch()),
        });
        for (const message of outcome.append) await appendMessage(message);
        emit({ type: "turn_end" });
        if (outcome.pause) {
          await log.append({ type: "paused", reason: outcome.pause });
          emit({ type: "paused", reason: outcome.pause });
          return { reason: "paused", pause: outcome.pause };
        }
      }
    }

    const result = (async (): Promise<RunResult> => {
      let outcome: RunResult;
      try {
        outcome = await drive();
      } catch (error) {
        outcome = { reason: "error", error: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.reason === "cancelled") await closeOpenCalls(CANCELLED_RESULT).catch(() => undefined);
      emit({ type: "run_end", reason: outcome.reason });
      channel.end();
      failureReporters.delete(reportFailure);
      pluginEmitters.delete(sendPluginEvent);
      finished = true;
      activeLogs.delete(log);
      return outcome;
    })();

    return {
      events: channel.iterable,
      result,
      queue: (text) => void queued.push(text),
      steer: (text) => void steered.push(text),
      cancel: () => {
        cancelled = true;
        controller.abort();
      },
    };
  }

  return {
    run,
    pending: (log) => ({ signals: [...(pendingSignals.get(log) ?? [])], watching: [...(watchedWork.get(log) ?? [])].map((entry) => entry.label) }),
  };
}
