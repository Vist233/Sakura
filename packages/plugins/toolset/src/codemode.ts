import { getQuickJS } from "quickjs-emscripten";
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";
import type { Content, Log, Plugin, Tool, ToolCall, ToolContext, ToolEffect, ToolResult } from "@sakura/kernel";

/**
 * Asks whether a call made from a script may run. The review plugin offers a function of this shape (`reviewPlugin(...).authorize`); it is
 * described here by its shape so that the two plugins do not depend on each other.
 */
export type Authorize = (
  call: ToolCall,
  context: { log: Log; signal: AbortSignal; tool(name: string): Tool | undefined; cwd?: string },
) => Promise<{ kind: "allow" } | { kind: "deny"; reason: string }>;

export interface CodemodeOptions {
  /** The tools the script can call as `tools.<name>(args)`. */
  catalog: Tool[];
  /** Tools with these effects can be called from a script (default: all of them). Others raise an error inside the script. */
  allowEffects?: ToolEffect[];
  /** Asked before every tool call a script makes, as the loop's hooks cannot see them. A refusal raises an error inside the script. Without it, every allowed call simply runs. */
  authorize?: Authorize;
  /**
   * The script is stopped after running this long (default 10 seconds). This is the script's own time: time spent running JavaScript, and time spent
   * waiting while no tool call is under way. Time spent waiting for a tool call does not count, because tools have limits of their own.
   */
  timeoutMs?: number;
  /** A limit on the whole run of the script, tool calls included. Not set by default. */
  totalTimeoutMs?: number;
  /** Memory limit of the script runtime in bytes (default 64 MB). */
  memoryBytes?: number;
  /** Longest text returned to the model, in characters; the middle is cut (default 20000). */
  maxOutputChars?: number;
}

const DESCRIPTION =
  "Runs a short JavaScript program in an isolated runtime (no files, no network, no timers) and returns what it prints and returns. " +
  "Inside the program, `tools.<name>(args)` calls a tool and returns a promise of its text; use `await`. `console.log` output is returned. " +
  "Use it to combine several tool calls or to process their results without sending everything through the conversation. Available tools: ";

const PRELUDE = `
globalThis.tools = new Proxy({}, { get: (_t, name) => async (args) => {
  const reply = JSON.parse(await __callTool(String(name), JSON.stringify(args === undefined ? {} : args)));
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.text;
} });
globalThis.console = { log: (...parts) => __print(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")) };
`;

/** Deeper than this, the host's own stack overflows before the runtime notices, which aborts the whole WebAssembly module; 256 KB still allows recursion about 1500 deep. */
const STACK_BYTES = 256 * 1024;

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });
const textOfContent = (content: Content[]): string => content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");

function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const half = Math.floor(limit / 2);
  return `${value.slice(0, half)}\n[... ${value.length - limit} characters omitted ...]\n${value.slice(-half)}`;
}

/**
 * Lets the model write one JavaScript program that calls tools, instead of one call per request. The program runs in QuickJS
 * (WebAssembly), which has no access to the machine: only the tools in the catalog, and only those whose effect is allowed.
 * Calls made from the script do not pass through the hooks of the loop, so `authorize` (for example the review plugin's) is asked
 * before each call. With no `authorize`, every call runs, as a direct call would with no review installed.
 *
 * The runtime only keeps the script itself away from the machine. The tools it calls (a shell command, a file write, an MCP tool) run outside the
 * runtime with their full power, so a call from a script is exactly as risky as the same call made directly, and needs the same review.
 */
export function codemodePlugin(options: CodemodeOptions): Plugin {
  const allowed = new Set<ToolEffect>(options.allowEffects ?? ["read", "write", "exec", "network", "irreversible"]);
  const byName = new Map(options.catalog.map((tool) => [tool.name, tool]));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const memoryBytes = options.memoryBytes ?? 64 * 1024 * 1024;
  const maxOutput = options.maxOutputChars ?? 20_000;

  let calls = 0;

  async function callTool(name: string, rawArgs: string, context: ToolContext): Promise<string> {
    const tool = byName.get(name);
    if (!tool) return JSON.stringify({ error: `no tool named '${name}'` });
    if (!allowed.has(tool.effect)) return JSON.stringify({ error: `tool '${name}' cannot be called from a script (effect: ${tool.effect})` });
    try {
      const args: unknown = JSON.parse(rawArgs);
      if (options.authorize) {
        const decision = await options.authorize(
          { id: `${context.callId}/${++calls}`, name, args },
          { log: context.log, signal: context.signal, tool: (wanted) => byName.get(wanted), ...(context.env?.cwd !== undefined ? { cwd: context.env.cwd } : {}) },
        );
        if (decision.kind === "deny") return JSON.stringify({ error: decision.reason });
      }
      const result = await tool.execute(args, context);
      const body = textOfContent(result.content);
      return JSON.stringify(result.isError ? { error: body } : { text: body });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  const runCode: Tool = {
    name: "run_code",
    description: DESCRIPTION + options.catalog.map((tool) => tool.name).join(", "),
    parameters: { type: "object", properties: { code: { type: "string", description: "The body of an async function; use `return` for the result" } }, required: ["code"] },
    effect: "exec",
    replay: "never",
    async execute(args, context): Promise<ToolResult> {
      const code = typeof (args as { code?: unknown })?.code === "string" ? (args as { code: string }).code : "";
      if (code.trim() === "") return text("'code' must be a non-empty string.", true);

      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(memoryBytes);
      runtime.setMaxStackSize(STACK_BYTES);

      // The script's own time is the time spent inside the runtime plus the time spent waiting while no tool call is under way.
      // Waiting for a tool call is not counted, but a loop that runs while a call is under way is (it is counted as it runs).
      const startedAt = Date.now();
      let insideMs = 0;
      let idleMs = 0;
      let sliceStart = 0;
      const used = () => insideMs + idleMs + (sliceStart > 0 ? Date.now() - sliceStart : 0);
      const inRuntime = <T>(work: () => T): T => {
        if (sliceStart > 0) return work();
        sliceStart = Date.now();
        try {
          return work();
        } finally {
          insideMs += Date.now() - sliceStart;
          sliceStart = 0;
        }
      };
      const overTotal = () => options.totalTimeoutMs !== undefined && Date.now() - startedAt > options.totalTimeoutMs;
      runtime.setInterruptHandler(() => used() > timeoutMs || overTotal() || context.signal.aborted);

      const vm: QuickJSContext = runtime.newContext();
      const printed: string[] = [];
      const unsettled = new Set<Promise<void>>(); // the calls that have not come back yet; the wait below must not include the ones that have, or it would not wait
      const handles: QuickJSHandle[] = [];
      const deferreds: Array<{ dispose(): void; alive: boolean }> = [];
      // The calls that have not returned. Each has its own signal, joined to the run's: cancelling the run stops them all, and when the script
      // ends the ones still under way are stopped. A call that has returned (a background command, say) is left to the run.
      const underway = new Set<AbortController>();

      const failure = (message: string): ToolResult => text(printed.length > 0 ? cut(`${printed.join("\n")}\n${message}`, maxOutput) : message, true);
      const late = (): string | undefined => {
        if (context.signal.aborted) return "The script was cancelled."; // the calls it was waiting for were stopped with the run, so the script may report their errors instead
        if (used() > timeoutMs) return `The script took longer than ${seconds(timeoutMs)} seconds and was stopped.`;
        if (overTotal()) return `The script took longer than ${seconds(options.totalTimeoutMs ?? 0)} seconds in total and was stopped.`;
        return undefined;
      };

      try {
        const print = vm.newFunction("__print", (line) => {
          printed.push(vm.getString(line));
        });
        vm.setProp(vm.global, "__print", print);
        print.dispose();

        const call = vm.newFunction("__callTool", (nameHandle, argsHandle) => {
          const promise = vm.newPromise();
          deferreds.push(promise);
          const name = vm.getString(nameHandle);
          const rawArgs = vm.getString(argsHandle);
          const controller = new AbortController();
          const stop = () => controller.abort();
          if (context.signal.aborted) stop();
          else context.signal.addEventListener("abort", stop, { once: true }); // stays joined after the call returns, so a background command it started is still stopped with the run
          underway.add(controller);
          const work: Promise<void> = callTool(name, rawArgs, { ...context, signal: controller.signal })
            .then((reply) => {
              if (!vm.alive) return;
              const value = vm.newString(reply);
              promise.resolve(value);
              value.dispose();
            })
            .catch(() => undefined)
            .finally(() => {
              underway.delete(controller);
              unsettled.delete(work);
            });
          unsettled.add(work);
          void promise.settled
            .then(() => {
              if (runtime.alive) inRuntime(() => runtime.executePendingJobs()); // the script may be over and the runtime gone by now
            })
            .catch(() => undefined);
          return promise.handle;
        });
        vm.setProp(vm.global, "__callTool", call);
        call.dispose();

        const prelude = inRuntime(() => vm.evalCode(PRELUDE));
        if (prelude.error) {
          prelude.error.dispose();
          return text("The script runtime could not start.", true);
        }
        prelude.value.dispose();

        const evaluated = inRuntime(() => vm.evalCode(`(async () => {\n${code}\n})()`));
        if (evaluated.error) {
          const message = vm.dump(evaluated.error);
          evaluated.error.dispose();
          return failure(late() ?? `Script error: ${formatError(message)}`);
        }
        handles.push(evaluated.value);

        inRuntime(() => runtime.executePendingJobs());
        // the script is done when its promise settles; tool calls it started finish in between
        let state = vm.getPromiseState(evaluated.value);
        let tick = Date.now();
        while (state.type === "pending") {
          const now = Date.now();
          if (underway.size === 0) idleMs += now - tick;
          tick = now;
          const over = late();
          if (over) return failure(over);
          await Promise.race([...unsettled, new Promise((resolve) => setTimeout(resolve, 20))]);
          inRuntime(() => runtime.executePendingJobs());
          state = vm.getPromiseState(evaluated.value);
        }

        const output = printed.length > 0 ? `${printed.join("\n")}\n` : "";
        if (state.type === "rejected") {
          const message = vm.dump(state.error);
          state.error.dispose();
          return failure(late() ?? `Script error: ${formatError(message)}`);
        }
        const value = vm.dump(state.value);
        state.value.dispose();
        const returned = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const combined = `${output}${returned}`.trimEnd();
        return text(cut(combined === "" ? "(no output)" : combined, maxOutput));
      } catch (error) {
        return failure(`Script failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        for (const controller of underway) controller.abort(); // calls still under way when the script ends are stopped
        for (const handle of handles) if (handle.alive) handle.dispose();
        for (const deferred of deferreds) if (deferred.alive) deferred.dispose();
        vm.dispose();
        runtime.dispose();
      }
    },
  };

  return { name: "codemode", compensates: "one tool call per model request is slow and fills the context with intermediate results", setup: (api) => api.registerTool(runCode) };
}

/** Seconds for an error message: a whole number when it is one, otherwise one decimal (0.3 and not 0). */
const seconds = (ms: number): number => Number((ms / 1000).toFixed(1));

function formatError(dumped: unknown): string {
  if (typeof dumped === "object" && dumped !== null) {
    const { name, message } = dumped as { name?: unknown; message?: unknown };
    if (typeof message === "string") return typeof name === "string" ? `${name}: ${message}` : message;
  }
  return String(dumped);
}
