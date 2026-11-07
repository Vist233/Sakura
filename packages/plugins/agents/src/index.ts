import type { Content, Log, Plugin, RunHandle, RunResult, Tool, ToolResult, UserInput } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { renderChild, summarize } from "./view.ts";
import type { ChildStatus } from "./view.ts";

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  /** Names of the tools this kind of sub-agent may use. Default: the same as its parent. */
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

/** What a sub-agent runs on. The assembler builds it; sub-agents do not get the `agents` plugin unless it says so. */
export interface ChildKernel {
  run(log: Log, input?: UserInput): RunHandle;
}

export interface AgentsOptions {
  createChild(request: { definition: AgentDefinition; model?: string; maxTurns?: number }): ChildKernel;
  /** Where a sub-agent's conversation is kept. Default: in memory. */
  openLog?(id: string): Promise<Log>;
  agents?: AgentDefinition[];
  /** How many sub-agents may exist in total. Default 20. */
  maxRegistered?: number;
  /** How many may run at the same time. Default 8. */
  maxRunning?: number;
}

const GENERAL: AgentDefinition = { name: "general", description: "A general-purpose sub-agent with the same tools as you. Give it a self-contained task." };

interface Child {
  id: string;
  definition: AgentDefinition;
  kernel: ChildKernel;
  log: Log;
  status: ChildStatus;
  handle?: RunHandle;
  done: Promise<RunResult>;
  note: string;
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
const contentText = (content: Content[]) =>
  content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

async function finalAnswer(log: Log): Promise<string> {
  const messages = await log.project();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && contentText(message.content)) return contentText(message.content);
  }
  return "(the sub-agent gave no written answer)";
}

const DELEGATE_DESCRIPTION = `Hand a self-contained task to a sub-agent that works in its own fresh context and report back. It starts knowing nothing about this conversation, so put everything it needs into the message.

When to delegate: the task is large or noisy (searching many files, running long investigations, reading lots of output) and you only need its conclusion; or several independent pieces can be done at the same time (use background: true and look at them later with agent_view).

When to do it yourself: the task is small, needs your full context, depends on a decision you have not made yet, or you would spend longer explaining it than doing it. Do not delegate the thing you are blocked on right now.

How to design the subtask: state the goal and what "done" looks like, name the files or areas to look at, say what must not be touched, and say what to report. Give each sub-agent a different, non-overlapping piece. Include the rules it must follow; it does not see yours. To continue with a sub-agent you already have, pass its id in "to" instead of starting a new one.

Do not wait reflexively: after starting background sub-agents, keep working on your own part, and only check on them (agent_view, optionally with wait_seconds) when you need their result. Do not poll in a loop.`;

/**
 * Optional sub-agents: delegate, agent_view, agent_stop. Sub-agents start with a fresh context, cannot start
 * sub-agents of their own unless their kernel says so, and are limited in number. Not in the default set.
 */
export function agentsPlugin(options: AgentsOptions): Plugin {
  const definitions = [GENERAL, ...(options.agents ?? [])];
  const maxRegistered = options.maxRegistered ?? 20;
  const maxRunning = options.maxRunning ?? 8;
  const openLog = options.openLog ?? (async () => createMemoryLog());
  const registries = new WeakMap<Log, Map<string, Child>>();
  let counter = 0;

  const registryFor = (log: Log): Map<string, Child> => {
    const existing = registries.get(log);
    if (existing) return existing;
    const created = new Map<string, Child>();
    registries.set(log, created);
    return created;
  };
  const running = (registry: Map<string, Child>) => [...registry.values()].filter((child) => child.status === "running").length;

  function start(child: Child, input: string): void {
    const handle = child.kernel.run(child.log, input);
    child.handle = handle;
    child.status = "running";
    child.note = "";
    void (async () => {
      for await (const _event of handle.events) void _event; // keep the stream flowing; the log has everything
    })();
    child.done = handle.result.then((result) => {
      child.status = result.reason === "done" ? "idle" : result.reason === "cancelled" ? "stopped" : "failed";
      child.note = result.reason === "paused" ? `paused (${result.pause})` : (result.error ?? "");
      return result;
    });
  }

  const delegate: Tool = {
    name: "delegate",
    description: DELEGATE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The task, with everything the sub-agent needs to know" },
        agent: { type: "string", description: `Kind of sub-agent. One of: ${definitions.map((definition) => `${definition.name} (${definition.description})`).join("; ")}` },
        to: { type: "string", description: "Id of an existing sub-agent to give a follow-up message instead of starting a new one" },
        background: { type: "boolean", description: "Start it and return at once; check later with agent_view" },
        max_turns: { type: "integer", description: "Stop the sub-agent after this many model turns" },
      },
      required: ["message"],
    },
    effect: "exec",
    replay: "never",
    async execute(args, { log, signal, watch }) {
      const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      if (typeof input.message !== "string" || input.message.trim() === "") return text("'message' must be a non-empty string.", true);
      const registry = registryFor(log);

      let child: Child | undefined;
      if (typeof input.to === "string") {
        child = registry.get(input.to);
        if (!child) return text(`There is no sub-agent with id '${input.to}'. Use agent_view with no id to list them.`, true);
        if (child.status === "running") {
          child.handle?.queue(input.message);
          return text(`Sub-agent ${child.id} is still working; your message was queued and will be handled when it finishes its current work.`);
        }
        if (running(registry) >= maxRunning) return text(`Too many sub-agents are running (${maxRunning}). Wait for one to finish or stop one.`, true);
        start(child, input.message);
      } else {
        const name = typeof input.agent === "string" ? input.agent : GENERAL.name;
        const definition = definitions.find((candidate) => candidate.name === name);
        if (!definition) return text(`Unknown kind of sub-agent '${name}'. Available: ${definitions.map((candidate) => candidate.name).join(", ")}.`, true);
        if (registry.size >= maxRegistered) return text(`There are already ${maxRegistered} sub-agents. Reuse one with "to", or stop ones you no longer need.`, true);
        if (running(registry) >= maxRunning) return text(`Too many sub-agents are running (${maxRunning}). Wait for one to finish or stop one.`, true);
        const id = `${definition.name}-${++counter}`;
        const maxTurns = typeof input.max_turns === "number" ? input.max_turns : definition.maxTurns;
        const kernel = options.createChild({ definition, ...(definition.model ? { model: definition.model } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}) });
        child = { id, definition, kernel, log: await openLog(id), status: "idle", done: Promise.resolve({ reason: "done" }), note: "" };
        registry.set(id, child);
        start(child, input.message);
      }

      if (input.background === true) {
        // the parent hears about the end by itself and need not poll
        const ended = watch(`sub-agent ${child.id}`);
        const started = child;
        void started.done.then(() =>
          ended(`Sub-agent ${started.id} ${started.status === "idle" ? "finished its work" : `ended (${started.status}${started.note ? `: ${started.note}` : ""})`}. Read its report with agent_view.`),
        );
        return text(`Started sub-agent ${child.id} in the background. Continue with your own work; look at it with agent_view when you need its result.`);
      }
      const onAbort = () => child!.handle?.cancel(); // a cancelled parent stops the sub-agent it is waiting for
      signal.addEventListener("abort", onAbort, { once: true });
      const result = await child.done;
      signal.removeEventListener("abort", onAbort);
      const answer = await finalAnswer(child.log);
      const ending = result.reason === "done" ? "" : `\n\n[The sub-agent ended early: ${child.note || result.reason}]`;
      return text(`Sub-agent ${child.id} finished.\n\n${answer}${ending}`, result.reason === "error");
    },
  };

  const agentView: Tool = {
    name: "agent_view",
    description:
      "Look at a sub-agent: its status and its latest steps, shown as short readable lines. With no id it lists all sub-agents. " +
      "Use wait_seconds to wait for a running one to finish before looking. Reasoning blocks are hidden unless thinking is true.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Sub-agent id; leave out to list all" },
        last: { type: "integer", description: "How many of the latest steps to show (default 10)" },
        thinking: { type: "boolean", description: "Also show reasoning (default false)" },
        wait_seconds: { type: "number", description: "Wait up to this long for the sub-agent to finish first" },
      },
    },
    effect: "read",
    async execute(args, { log, signal }) {
      const input = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
      const registry = registryFor(log);
      if (typeof input.id !== "string") {
        if (registry.size === 0) return text("There are no sub-agents.");
        const lines: string[] = [];
        for (const child of registry.values()) {
          const summary = summarize(child.id, child.definition.name, child.status, await child.log.branch());
          lines.push(`${summary.id} (${summary.name}): ${summary.status}, ${summary.turns} turns, ${summary.tokens} tokens`);
        }
        return text(lines.join("\n"));
      }
      const child = registry.get(input.id);
      if (!child) return text(`There is no sub-agent with id '${input.id}'.`, true);
      if (typeof input.wait_seconds === "number" && input.wait_seconds > 0 && child.status === "running") {
        await Promise.race([
          child.done,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, (input.wait_seconds as number) * 1000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve(undefined);
              },
              { once: true },
            );
          }),
        ]);
      }
      const entries = await child.log.branch();
      const body = renderChild(summarize(child.id, child.definition.name, child.status, entries), entries, {
        last: typeof input.last === "number" && input.last > 0 ? Math.floor(input.last) : 10,
        thinking: input.thinking === true,
      });
      return text(child.note ? `${body}\nnote: ${child.note}` : body);
    },
  };

  const agentStop: Tool = {
    name: "agent_stop",
    description: "Stop a running sub-agent. Its conversation is kept, so you can still look at it or give it a follow-up with delegate.",
    parameters: { type: "object", properties: { id: { type: "string", description: "Sub-agent id" } }, required: ["id"] },
    effect: "exec",
    async execute(args, { log }) {
      const id = (args as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return text("'id' must be a string.", true);
      const child = registryFor(log).get(id);
      if (!child) return text(`There is no sub-agent with id '${id}'.`, true);
      if (child.status !== "running") return text(`Sub-agent ${id} is not running (${child.status}).`);
      child.handle?.cancel();
      await child.done;
      return text(`Stopped sub-agent ${id}.`);
    },
  };

  return {
    name: "agents",
    compensates: "one conversation cannot hold every large side task without filling its context",
    setup(api) {
      api.registerTool(delegate);
      api.registerTool(agentView);
      api.registerTool(agentStop);
    },
  };
}
