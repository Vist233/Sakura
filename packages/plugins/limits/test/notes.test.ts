// The notes the model gets about its limits: what is used, and the request to finish near the end.
import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, Message } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import { limitsPlugin } from "../src/index.ts";

const env = { cwd: "/", resolve: (path: string) => path, dispose: async () => undefined } as unknown as Environment;
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** Runs one prompt; the model answers `replies` times, each time calling a tool so the run goes on, and the clock moves `stepMs` per turn. */
async function runWith(options: Parameters<typeof limitsPlugin>[0], replies: number, stepMs = 0) {
  let clock = 1_000_000;
  const plugin = limitsPlugin({ ...options, now: () => clock });
  const script = Array.from({ length: replies }, (_, index) => ({ toolCalls: [{ name: "tick", args: {}, id: `t${index}` }] }));
  const llm = createFauxClient([...script, { text: "done" }]);
  const tick = {
    name: "tick",
    description: "",
    parameters: { type: "object" as const, properties: {} },
    effect: "read" as const,
    async execute() {
      clock += stepMs;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  };
  const kernel = createKernel({ llm, env, system: "s", plugins: [plugin], tools: [tick], compaction: false, now: () => clock });
  const log = createMemoryLog();
  const handle = kernel.run(log, "go");
  for await (const _event of handle.events) void _event;
  const result = await handle.result;
  const lastOf = (request: number) => textOf(llm.requests[request]!.messages.at(-1)!);
  return { result, llm, log, lastOf };
}

describe("notes about the limits", () => {
  it("say nothing when no limit is set", async () => {
    const { llm } = await runWith({}, 2);
    for (const request of llm.requests) expect(request.messages.map(textOf).join("\n")).not.toContain("[Limits");
  });

  it("show the time used against the time given, and the turn against the turn limit", async () => {
    const { lastOf } = await runWith({ maxRunSeconds: 900, maxTurns: 40 }, 3, 60_000);
    expect(lastOf(0)).toBe("[Limits: 0 of 15 minutes used.]"); // before the first reply the turns are not known yet
    expect(lastOf(1)).toBe("[Limits: 1 of 15 minutes used; turn 2 of 40.]");
    expect(lastOf(2)).toBe("[Limits: 2 of 15 minutes used; turn 3 of 40.]");
  });

  it("show tokens and money when those limits are set", async () => {
    const { lastOf } = await runWith({ maxTokens: 1000, maxCostUsd: 1, prices: { input: 1, output: 1 } }, 1);
    expect(lastOf(1)).toMatch(/^\[Limits: \d+ of 1000 tokens used; \$[\d.]+ of \$1\.00 spent\.\]$/);
  });

  it("ask the model to finish when a limit is 80 percent used (and not before)", async () => {
    const { lastOf } = await runWith({ maxRunSeconds: 600 }, 3, 240_000);
    expect(lastOf(1)).not.toContain("close to a limit"); // 4 of 10 minutes
    expect(lastOf(2)).toContain("8 of 10 minutes used");
    expect(lastOf(2)).toContain("You are close to a limit: finish now. Make sure the result passes its checks, verify it with a command, then stop.");
  });

  it("warnAt moves the point", async () => {
    const { lastOf } = await runWith({ maxRunSeconds: 600, warnAt: 0.3 }, 2, 240_000);
    expect(lastOf(1)).toContain("close to a limit");
  });

  it("the warning follows the limit that is nearest, whichever it is", async () => {
    const { lastOf } = await runWith({ maxRunSeconds: 6000, maxTurns: 2 }, 2);
    expect(lastOf(1)).toContain("turn 2 of 2");
    expect(lastOf(1)).toContain("close to a limit"); // the last turn is past 80 percent
  });

  it("are not kept in the log", async () => {
    const { log } = await runWith({ maxRunSeconds: 900 }, 2, 60_000);
    const stored = (await log.project()).map(textOf).join("\n");
    expect(stored).not.toContain("[Limits");
  });

  it("can be turned off", async () => {
    const { llm } = await runWith({ maxRunSeconds: 900, notes: false }, 2, 60_000);
    for (const request of llm.requests) expect(request.messages.map(textOf).join("\n")).not.toContain("[Limits");
  });

  it("do not change what the limits do: the run still pauses at the limit", async () => {
    const { result } = await runWith({ maxTurns: 2 }, 5);
    expect(result).toMatchObject({ reason: "paused", pause: "budget" });
  });
});

describe("remainingMs", () => {
  it("is undefined without a time limit, and counts down from the start of the run", async () => {
    expect(limitsPlugin({ maxTurns: 3 }).remainingMs()).toBeUndefined();
    let clock = 0;
    const plugin = limitsPlugin({ maxRunSeconds: 100, now: () => clock });
    expect(plugin.remainingMs()).toBe(100_000);
    clock = 40_000;
    expect(plugin.remainingMs()).toBe(60_000);
    clock = 500_000;
    expect(plugin.remainingMs()).toBe(0);
  });
});
