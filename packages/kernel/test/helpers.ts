import { createFauxClient } from "@sakura/testing";
import type { FauxScript } from "@sakura/testing";
import { createMemoryLog } from "@sakura/session";
import { createKernel } from "../src/index.ts";
import type { CompactionConfig, Content, Environment, Event, ExecResult, KernelConfig, Log, Message, Plugin, RunHandle, RunResult, Tool, ToolResult } from "../src/index.ts";

export const env: Environment = {
  cwd: "/work",
  resolve: (path) => path,
  readFile: async () => {
    throw new Error("not implemented");
  },
  writeFile: async () => {
    throw new Error("not implemented");
  },
  stat: async () => undefined,
  list: async () => [],
  exec: async () => ({ exitCode: 0, output: "", timedOut: false }),
  spawn: () => {
    throw new Error("not implemented");
  },
  dispose: async () => undefined,
};

export const text = (value: string): Content[] => [{ type: "text", text: value }];
export const textOf = (message: Message): string => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

export function tool(name: string, run: (args: unknown) => Promise<ToolResult> | ToolResult, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: "object" },
    effect: "read",
    execute: async (args) => run(args),
    ...extra,
  };
}

export const echo = (name = "echo", extra: Partial<Tool> = {}): Tool => tool(name, (args) => ({ content: text(`echo:${JSON.stringify(args)}`) }), extra);

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Setup {
  script: FauxScript;
  tools?: Tool[];
  plugins?: Plugin[];
  log?: Log;
  maxTokens?: number;
  contextWindow?: number;
  compaction?: false | Partial<CompactionConfig>;
  goal?: KernelConfig["goal"];
  environment?: Environment;
  onSignal?: KernelConfig["onSignal"];
}

export function setup(options: Setup) {
  const llm = createFauxClient(options.script, options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {});
  const log = options.log ?? createMemoryLog({ now: () => 1000 });
  const kernel = createKernel({
    llm,
    env: options.environment ?? env,
    system: "system prompt",
    ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    ...(options.goal !== undefined ? { goal: options.goal } : {}),
    tools: options.tools ?? [],
    plugins: options.plugins ?? [],
    now: () => 1000,
    ...(options.onSignal ? { onSignal: options.onSignal } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  });
  return { kernel, llm, log };
}

export async function finish(handle: RunHandle): Promise<{ events: Event[]; result: RunResult }> {
  const events: Event[] = [];
  const reading = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const result = await handle.result;
  await reading;
  return { events, result };
}

export async function runOnce(options: Setup, input: string | undefined = "go") {
  const built = setup(options);
  const outcome = await finish(built.kernel.run(built.log, input));
  return { ...built, ...outcome };
}

export const roles = async (log: Log): Promise<string[]> => (await log.project()).map((message) => message.role);

/** An environment whose exec returns scripted results, for goal verification. */
export function scriptedEnv(results: Array<Partial<ExecResult>>): { environment: Environment; commands: string[] } {
  const commands: string[] = [];
  let index = 0;
  const environment: Environment = {
    ...env,
    exec: async (command) => {
      commands.push(command);
      const next = results[Math.min(index++, results.length - 1)] ?? {};
      return { exitCode: 0, output: "", timedOut: false, ...next };
    },
  };
  return { environment, commands };
}
