// Exact-behaviour tests for loop.ts, added after mutation testing showed these details were not pinned down.
import { describe, expect, it } from "vitest";
import { createKernel, ProviderError } from "../src/index.ts";
import type { LlmClient, LlmEvent, LlmRequest, Plugin, TurnInfo } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import { echo, env, finish, roles, runOnce, scriptedEnv, setup, text, textOf, tool } from "./helpers.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const plugin = (name: string, setupFn: Plugin["setup"]): Plugin => ({ name, setup: setupFn });

describe("the request the model gets", () => {
  it("has maxTokens and thinking only when they are configured", async () => {
    const llm = createFauxClient([{ text: "a" }]);
    const kernel = createKernel({ llm, env, system: "s", maxTokens: 777, thinking: "high", now: () => 1 });
    await finish(kernel.run(createMemoryLog(), "go"));
    expect(llm.requests[0]).toMatchObject({ maxTokens: 777, thinking: "high" });

    const plain = setup({ script: [{ text: "a" }] });
    await finish(plain.kernel.run(plain.log, "go"));
    expect("maxTokens" in plain.llm.requests[0]!).toBe(false);
    expect("thinking" in plain.llm.requests[0]!).toBe(false);
  });

  it("maxTokens of zero is still sent (only undefined means not configured)", async () => {
    const llm = createFauxClient([{ text: "a" }]);
    const kernel = createKernel({ llm, env, system: "s", maxTokens: 0, now: () => 1 });
    await finish(kernel.run(createMemoryLog(), "go"));
    expect(llm.requests[0]?.maxTokens).toBe(0);
  });
});

describe("what the model's reply is stored as", () => {
  const clientFrom = (events: LlmEvent[][]): LlmClient => {
    let index = 0;
    return {
      model: { id: "m", contextWindow: 10_000, supportsImages: false },
      stream: async function* (_request: LlmRequest) {
        yield* events[Math.min(index++, events.length - 1)]!;
      },
    };
  };

  it("keeps provider parts first, then text, then tool calls, in that order", async () => {
    const llm = clientFrom([
      [
        { type: "provider", vendor: "v", data: { reasoning: "thought" } },
        { type: "text_delta", delta: "hello " },
        { type: "text_delta", delta: "world" },
        { type: "tool_call", call: { id: "c1", name: "echo", args: { a: 1 } } },
        { type: "done", stop: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "end" },
        { type: "done", stop: "stop" },
      ],
    ]);
    const log = createMemoryLog();
    const kernel = createKernel({ llm, env, system: "s", tools: [echo()], compaction: false, now: () => 1 });
    await finish(kernel.run(log, "go"));
    const assistant = (await log.project()).find((message) => message.role === "assistant")!;
    expect(assistant.content.map((part) => part.type)).toEqual(["provider", "text", "tool_call"]);
    expect(assistant.content[1]).toEqual({ type: "text", text: "hello world" });
    expect(assistant.stop).toBe("tool_use");
  });

  it("a restart event throws away everything received so far", async () => {
    const llm = clientFrom([
      [
        { type: "provider", vendor: "v", data: 1 },
        { type: "text_delta", delta: "partial" },
        { type: "tool_call", call: { id: "x", name: "echo", args: {} } },
        { type: "usage", usage: usage(9, 9) },
        { type: "restart" },
        { type: "text_delta", delta: "clean" },
        { type: "done", stop: "stop" },
      ],
    ]);
    const log = createMemoryLog();
    const kernel = createKernel({ llm, env, system: "s", tools: [echo()], compaction: false, now: () => 1 });
    const { events } = await finish(kernel.run(log, "go"));
    const assistant = (await log.project()).find((message) => message.role === "assistant")!;
    expect(assistant.content).toEqual([{ type: "text", text: "clean" }]);
    expect(assistant.usage).toBeUndefined();
    expect(assistant.stop).toBe("stop");
    expect(events.filter((event) => event.type === "message_reset")).toHaveLength(1);
  });

  it("a text reply without a done event still has the default stop reason 'stop'", async () => {
    const llm = clientFrom([[{ type: "text_delta", delta: "x" }]]);
    const log = createMemoryLog();
    await finish(createKernel({ llm, env, system: "s", compaction: false, now: () => 1 }).run(log, "go"));
    expect((await log.project()).at(-1)?.stop).toBe("stop");
  });

  it("an empty reply has no text part", async () => {
    const llm = clientFrom([[{ type: "done", stop: "stop" }]]);
    const log = createMemoryLog();
    await finish(createKernel({ llm, env, system: "s", compaction: false, now: () => 1 }).run(log, "go"));
    expect((await log.project()).at(-1)?.content).toEqual([]);
  });

  it("a cut-off tool call is stored with empty arguments and answered with the 'cut off' error, without running the tool", async () => {
    let ran = false;
    const t = tool("big", () => {
      ran = true;
      return { content: text("no") };
    });
    const { log } = await runOnce({ script: [{ truncatedToolCall: { name: "big", id: "t1" } }, { text: "retrying smaller" }], tools: [t] });
    const messages = await log.project();
    const call = messages[1]!.content.find((part) => part.type === "tool_call");
    expect(call).toMatchObject({ id: "t1", name: "big", args: {} });
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "t1", isError: true });
    expect(textOf(messages[2]!)).toContain("cut off");
    expect(ran).toBe(false);
  });
});

describe("totals given to turn.end hooks", () => {
  async function observe(script: Parameters<typeof setup>[0]["script"], tools = [echo()]) {
    const seen: TurnInfo[] = [];
    const p = plugin("watch", (api) =>
      api.on("turn.end", (turn) => {
        seen.push(turn);
      }),
    );
    const built = setup({ script, tools, plugins: [p] });
    await finish(built.kernel.run(built.log, "go"));
    return seen;
  }

  it("adds input, output, cache read and cache write over all replies, and counts replies", async () => {
    const seen = await observe([
      { toolCalls: [{ name: "echo", args: {}, id: "a" }], usage: usage(100, 10, 5, 1) },
      { text: "done", usage: usage(200, 20, 50, 2) },
    ]);
    expect(seen[0]!.totals).toEqual({ input: 100, output: 10, cacheRead: 5, cacheWrite: 1, turns: 1 });
    expect(seen[1]!.totals).toEqual({ input: 300, output: 30, cacheRead: 55, cacheWrite: 3, turns: 2 });
  });

  it("toolCallCount counts the calls of the turn, and a cut-off call counts too", async () => {
    const seen = await observe([
      {
        toolCalls: [
          { name: "echo", args: {}, id: "a" },
          { name: "echo", args: {}, id: "b" },
        ],
      },
      { truncatedToolCall: { name: "echo", id: "t" } },
      { text: "done" },
    ]);
    expect(seen.map((turn) => turn.toolCallCount)).toEqual([2, 1, 0]);
  });

  it("usage entries of side requests (compaction, goal check) are included in the totals", async () => {
    const log = createMemoryLog();
    await log.append({ type: "usage", kind: "compaction", usage: usage(1000, 100) });
    const seen: TurnInfo[] = [];
    const p = plugin("watch", (api) =>
      api.on("turn.end", (turn) => {
        seen.push(turn);
      }),
    );
    const llm = createFauxClient([{ text: "x", usage: usage(1, 1) }]);
    await finish(createKernel({ llm, env, system: "s", plugins: [p], compaction: false, now: () => 1 }).run(log, "go"));
    expect(seen[0]!.totals).toMatchObject({ input: 1001, output: 101, turns: 1 });
  });
});

describe("compaction records its cost and its place", () => {
  it("writes a usage entry of kind 'compaction' and a compaction entry that keeps the newest turn", async () => {
    const log = createMemoryLog();
    for (let index = 0; index < 4; index++) {
      await log.append({ type: "message", message: { role: "user", content: text("u".repeat(400)), ts: 1 } });
      await log.append({ type: "message", message: { role: "assistant", content: text("a".repeat(400)), ts: 1 } });
    }
    const built = setup({
      script: [{ text: "the summary", usage: usage(50, 5) }, { text: "answer" }],
      log,
      contextWindow: 1000,
      compaction: { reserveTokens: 100, keepRecentTokens: 150 },
    });
    // the context is over 900 tokens by estimate, so the run compacts before asking
    await log.append({ type: "message", message: { role: "user", content: text("w".repeat(2000)), ts: 1 } });
    await finish(built.kernel.run(log));
    const branch = await log.branch();
    const compaction = branch.find((entry) => entry.type === "compaction");
    expect(compaction).toMatchObject({ type: "compaction", summary: "the summary" });
    expect(branch.find((entry) => entry.type === "usage" && entry.kind === "compaction")).toMatchObject({ usage: usage(50, 5) });
  });

  it("a summary that is only whitespace is not used: nothing is compacted", async () => {
    const log = createMemoryLog();
    for (let index = 0; index < 4; index++) {
      await log.append({ type: "message", message: { role: "user", content: text("u".repeat(400)), ts: 1 } });
      await log.append({ type: "message", message: { role: "assistant", content: text("a".repeat(400)), ts: 1 } });
    }
    await log.append({ type: "message", message: { role: "user", content: text("w".repeat(2000)), ts: 1 } });
    const built = setup({ script: [{ text: "   \n " }, { text: "answer" }], log, contextWindow: 1000, compaction: { reserveTokens: 100, keepRecentTokens: 150 } });
    await finish(built.kernel.run(log));
    expect((await log.branch()).some((entry) => entry.type === "compaction")).toBe(false);
  });
});

describe("context overflow", () => {
  it("is answered with one compaction and one retry, and a second overflow is an error", async () => {
    const overflow = new ProviderError("context_overflow", "too long");
    const log = createMemoryLog();
    for (let index = 0; index < 4; index++) {
      await log.append({ type: "message", message: { role: "user", content: text("u".repeat(400)), ts: 1 } });
      await log.append({ type: "message", message: { role: "assistant", content: text("a".repeat(400)), ts: 1 } });
    }
    await log.append({ type: "message", message: { role: "user", content: text("last question"), ts: 1 } });
    const built = setup({ script: [{ error: overflow }, { text: "summary" }, { error: overflow }, { text: "unused" }], log, compaction: { reserveTokens: 10, keepRecentTokens: 100 } });
    const { result } = await finish(built.kernel.run(log));
    expect(result.reason).toBe("error");
    expect(built.llm.requests).toHaveLength(3); // overflow, summary, overflow again: no third try
  });

  it("the retry allowance comes back after a successful reply", async () => {
    const overflow = new ProviderError("context_overflow", "too long");
    const log = createMemoryLog();
    for (let index = 0; index < 4; index++) {
      await log.append({ type: "message", message: { role: "user", content: text("u".repeat(400)), ts: 1 } });
      await log.append({ type: "message", message: { role: "assistant", content: text("a".repeat(400)), ts: 1 } });
    }
    await log.append({ type: "message", message: { role: "user", content: text("q"), ts: 1 } });
    const t = echo();
    const built = setup({
      script: [{ error: overflow }, { text: "summary one" }, { toolCalls: [{ name: "echo", args: {}, id: "e" }] }, { error: overflow }, { text: "summary two" }, { text: "finished" }],
      log,
      tools: [t],
      compaction: { reserveTokens: 10, keepRecentTokens: 60 },
    });
    const { result } = await finish(built.kernel.run(log));
    expect(result.reason).toBe("done");
    expect((await log.branch()).filter((entry) => entry.type === "compaction").length).toBe(2);
  });
});

describe("goal wrap-up details", () => {
  const checklist = (status: string) => ({ text: `- [${status}] the task :: evidence` });

  it("a goal with a verify command only completes when the command succeeds; a failure goes back to the model with the tail of its output", async () => {
    const { environment, commands } = scriptedEnv([{ exitCode: 1, output: `${"x".repeat(5000)}END-OF-FAILURE` }, { exitCode: 0 }]);
    const built = setup({
      script: [{ text: "first try" }, checklist("done"), { text: "fixed it" }, checklist("done")],
      goal: { objective: "make it pass", verify: "npm test" },
      environment,
    });
    const { result } = await finish(built.kernel.run(built.log, "go"));
    expect(result.reason).toBe("done");
    expect(commands).toEqual(["npm test", "npm test"]);
    const failure = (await built.log.project()).find((message) => message.role === "user" && textOf(message).includes("END-OF-FAILURE"));
    expect(failure).toBeDefined();
    expect(textOf(failure!).length).toBeLessThan(6000);
    expect(textOf(failure!)).not.toContain("x".repeat(4500));
    const goal = (await built.log.branch()).filter((entry) => entry.type === "goal").at(-1);
    expect(goal).toMatchObject({ goal: { status: "complete" } });
  });

  it("without a verify command nothing is executed", async () => {
    const { environment, commands } = scriptedEnv([{ exitCode: 1 }]);
    const built = setup({ script: [{ text: "ok" }, checklist("done")], goal: { objective: "x" }, environment });
    await finish(built.kernel.run(built.log, "go"));
    expect(commands).toEqual([]);
  });

  it("the human streak is reset to zero when the next verdict is 'continue'", async () => {
    const built = setup({ script: [{ text: "a" }, checklist("human"), { text: "b" }, checklist("todo"), { text: "c" }, checklist("done")], goal: { objective: "x" } });
    await finish(built.kernel.run(built.log, "go"));
    const streaks = (await built.log.branch()).flatMap((entry) => (entry.type === "goal" ? [entry.goal.humanStreak] : []));
    expect(streaks).toEqual([0, 1, 0, 0]);
  });

  it("two 'human' verdicts do not block; the third does", async () => {
    const built = setup({ script: [{ text: "a" }, checklist("human"), { text: "b" }, checklist("human"), { text: "c" }, checklist("human")], goal: { objective: "x" } });
    const { result } = await finish(built.kernel.run(built.log, "go"));
    expect(result).toMatchObject({ reason: "paused", pause: "blocked" });
    const last = (await built.log.branch()).filter((entry) => entry.type === "goal").at(-1);
    expect(last).toMatchObject({ goal: { status: "blocked", humanStreak: 3 } });
  });

  it("the goal check is recorded with the verdict and the parsed items, and its cost as usage", async () => {
    const built = setup({ script: [{ text: "a" }, { text: "- [done] x :: proof", usage: usage(7, 3) }], goal: { objective: "x" } });
    await finish(built.kernel.run(built.log, "go"));
    const branch = await built.log.branch();
    expect(branch.find((entry) => entry.type === "custom" && entry.customType === "goal_check")).toMatchObject({
      data: { verdict: "complete", items: [{ status: "done", text: "x", note: "proof" }] },
    });
    expect(branch.find((entry) => entry.type === "usage" && entry.kind === "goal_check")).toMatchObject({ usage: usage(7, 3) });
  });
});

describe("recovery and cancellation keep results exact", () => {
  it("on resume only the calls without a result run again, and each result appears exactly once", async () => {
    const log = createMemoryLog();
    await log.append({ type: "message", message: { role: "user", content: text("go"), ts: 1 } });
    await log.append({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "a", name: "echo", args: { n: 1 } },
          { type: "tool_call", id: "b", name: "echo", args: { n: 2 } },
        ],
        ts: 1,
        stop: "tool_use",
      },
    });
    await log.append({ type: "message", message: { role: "tool", content: text("already"), ts: 1, toolCallId: "a", toolName: "echo" } });
    const ran: unknown[] = [];
    const t = tool("echo", (args) => {
      ran.push(args);
      return { content: text("fresh") };
    });
    const built = setup({ script: [{ text: "finished" }], tools: [t], log });
    await finish(built.kernel.run(log));
    expect(ran).toEqual([{ n: 2 }]);
    const results = (await log.project()).filter((message) => message.role === "tool");
    expect(results.map((message) => [message.toolCallId, textOf(message)])).toEqual([
      ["a", "already"],
      ["b", "fresh"],
    ]);
  });

  it("a never-replay tool that had started is not run again; the other open call is", async () => {
    const log = createMemoryLog();
    await log.append({ type: "message", message: { role: "user", content: text("go"), ts: 1 } });
    await log.append({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "d", name: "deploy", args: {} },
          { type: "tool_call", id: "r", name: "peek", args: {} },
        ],
        ts: 1,
        stop: "tool_use",
      },
    });
    await log.append({ type: "tool_started", toolCallId: "d", toolName: "deploy" });
    const ran: string[] = [];
    const deploy = tool(
      "deploy",
      () => {
        ran.push("deploy");
        return { content: text("x") };
      },
      { effect: "exec", replay: "never" },
    );
    const peek = tool("peek", () => {
      ran.push("peek");
      return { content: text("seen") };
    });
    const built = setup({ script: [{ text: "ok" }], tools: [deploy, peek], log });
    await finish(built.kernel.run(log));
    expect(ran).toEqual(["peek"]);
    const interrupted = (await log.project()).find((message) => message.toolCallId === "d");
    expect(interrupted).toMatchObject({ isError: true });
    expect(textOf(interrupted!)).toContain("interrupted");
  });

  it("a never-replay tool whose start was never recorded is simply run", async () => {
    const log = createMemoryLog();
    await log.append({ type: "message", message: { role: "user", content: text("go"), ts: 1 } });
    await log.append({ type: "message", message: { role: "assistant", content: [{ type: "tool_call", id: "d", name: "deploy", args: {} }], ts: 1, stop: "tool_use" } });
    const ran: string[] = [];
    const deploy = tool(
      "deploy",
      () => {
        ran.push("deploy");
        return { content: text("x") };
      },
      { effect: "exec", replay: "never" },
    );
    await finish(setup({ script: [{ text: "ok" }], tools: [deploy], log }).kernel.run(log));
    expect(ran).toEqual(["deploy"]);
  });

  it("an error thrown by a tool becomes an error result with its message", async () => {
    const t = tool("boom", () => {
      throw new Error("kaput");
    });
    const { log } = await runOnce({ script: [{ toolCalls: [{ name: "boom", args: {}, id: "b" }] }, { text: "ok" }], tools: [t] });
    const result = (await log.project()).find((message) => message.role === "tool")!;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("kaput");
    expect(await roles(log)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("a call to a tool that does not exist gets a clear error", async () => {
    const { log } = await runOnce({ script: [{ toolCalls: [{ name: "ghost", args: {}, id: "g" }] }, { text: "ok" }] });
    const result = (await log.project()).find((message) => message.role === "tool")!;
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe("Tool 'ghost' is not available.");
  });
});
