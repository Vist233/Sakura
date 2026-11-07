import { describe, expect, it } from "vitest";
import { createMemoryLog } from "@sakura/session";
import { createRng } from "@sakura/testing";
import { ProviderError } from "../src/index.ts";
import type { Log, Plugin, ProviderErrorKind, RunHandle } from "../src/index.ts";
import { delay, echo, finish, roles, runOnce, setup, text, textOf, tool } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const plugin = (name: string, setupFn: Plugin["setup"]): Plugin => ({ name, setup: setupFn });

describe("queue and steer", () => {
  for (const seed of range(10)) {
    it(`queue: handled only after the agent would stop (seed ${seed})`, async () => {
      const { kernel, log } = setup({ script: [{ text: "r1" }, { text: "r2" }] });
      const handle = kernel.run(log, "first");
      handle.queue(`later ${seed}`);
      const { result } = await finish(handle);
      expect(result.reason).toBe("done");
      expect((await log.project()).map(textOf)).toEqual(["first", "r1", `later ${seed}`, "r2"]);
    });
  }

  for (const count of range(5, 10)) {
    it(`queue keeps order for ${count} messages`, async () => {
      const script = Array.from({ length: count + 1 }, (_, index) => ({ text: `r${index}` }));
      const { kernel, log } = setup({ script });
      const handle = kernel.run(log, "start");
      for (let index = 0; index < count; index++) handle.queue(`q${index}`);
      await finish(handle);
      const users = (await log.project()).filter((message) => message.role === "user").map(textOf);
      expect(users).toEqual(["start", ...Array.from({ length: count }, (_, index) => `q${index}`)]);
    });
  }

  for (const seed of range(10, 20)) {
    it(`steer: arrives after the tool results and before the next request (seed ${seed})`, async () => {
      let handle: RunHandle | undefined;
      const t = tool("t", () => {
        handle?.steer(`steer ${seed}`);
        return { content: text("result") };
      });
      const { kernel, log, llm } = setup({
        script: [{ toolCalls: [{ name: "t", args: {}, id: "c1" }] }, { text: "after steer" }],
        tools: [t],
      });
      handle = kernel.run(log, "go");
      await finish(handle);
      expect(await roles(log)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
      expect(textOf(llm.requests[1]!.messages.at(-1)!)).toBe(`steer ${seed}`);
    });
  }

  it("steer sent while the last reply is being produced is not lost", async () => {
    let handle: RunHandle | undefined;
    const spy = plugin("spy", (api) => {
      let sent = false;
      api.on("request", () => {
        if (!sent) handle?.steer("late");
        sent = true;
      });
    });
    const { kernel, log } = setup({ script: [{ text: "final" }, { text: "answer to late" }], plugins: [spy] });
    handle = kernel.run(log, "go");
    const { result } = await finish(handle);
    expect(result.reason).toBe("done");
    expect((await log.project()).map(textOf)).toContain("late");
  });

  it("steer before the first request is sent together with the input", async () => {
    const { kernel, log, llm } = setup({ script: [{ text: "ok" }] });
    const handle = kernel.run(log, "input");
    handle.steer("extra");
    await finish(handle);
    expect(llm.requests[0]?.messages.map(textOf)).toEqual(["input", "extra"]);
  });
});

describe("cancel", () => {
  for (const seed of range(8, 30)) {
    it(`cancel during the model stream drops the partial reply (seed ${seed})`, async () => {
      const { kernel, log } = setup({ script: [{ hang: true }] });
      const handle = kernel.run(log, "go");
      await delay(seed % 4);
      handle.cancel();
      const { result, events } = await finish(handle);
      expect(result.reason).toBe("cancelled");
      expect(await roles(log)).toEqual(["user"]);
      expect(events.at(-1)).toEqual({ type: "run_end", reason: "cancelled" });
    });
  }

  for (const count of range(6, 40)) {
    it(`cancel during tools leaves a result for every call (${count} calls)`, async () => {
      const slow = tool("slow", () => new Promise((resolve) => setTimeout(() => resolve({ content: text("late") }), 200)), { effect: "write" });
      const { kernel, log } = setup({
        script: [{ toolCalls: Array.from({ length: count }, (_, index) => ({ name: "slow", args: {}, id: `c${index}` })) }, { text: "never" }],
        tools: [slow],
      });
      const handle = kernel.run(log, "go");
      await delay(20);
      handle.cancel();
      const { result } = await finish(handle);
      expect(result.reason).toBe("cancelled");
      const messages = await log.project();
      const answered = messages.filter((message) => message.role === "tool").map((message) => message.toolCallId);
      expect(new Set(answered)).toEqual(new Set(Array.from({ length: count }, (_, index) => `c${index}`)));
      expect(messages.at(-1)?.role).toBe("tool");
    });
  }

  it("a tool sees the abort signal", async () => {
    let aborted = false;
    const t = tool("t", () => new Promise((resolve) => setTimeout(() => resolve({ content: text("x") }), 100)));
    const watching = {
      ...t,
      execute: async (_a: unknown, ctx: { signal: AbortSignal }) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return t.execute({}, ctx as never);
      },
    };
    const { kernel, log } = setup({ script: [{ toolCalls: [{ name: "t", args: {}, id: "c" }] }], tools: [watching] });
    const handle = kernel.run(log, "go");
    await delay(10);
    handle.cancel();
    await finish(handle);
    expect(aborted).toBe(true);
  });

  for (const variant of range(4, 60)) {
    it(`cancelling immediately still ends cleanly (variant ${variant})`, async () => {
      const { kernel, log } = setup({ script: [{ text: "a" }] });
      const handle = kernel.run(log, "go");
      handle.cancel();
      const { result } = await finish(handle);
      expect(["cancelled", "done"]).toContain(result.reason);
      expect((await log.project())[0]?.role).toBe("user");
    });
  }

  it("the log can be used again after a cancel", async () => {
    const { kernel, log } = setup({ script: [{ hang: true }, { text: "back" }] });
    const first = kernel.run(log, "one");
    await delay(5);
    first.cancel();
    await finish(first);
    await finish(kernel.run(log, "two"));
    expect((await log.project()).map(textOf)).toEqual(["one", "two", "back"]);
  });
});

describe("provider errors", () => {
  const kinds: ProviderErrorKind[] = ["rate_limit", "quota", "overloaded", "context_overflow", "auth", "network", "invalid_request", "other"];
  for (const kind of kinds) {
    for (const variant of range(2)) {
      it(`without a hook, ${kind} ends the run with an error (variant ${variant})`, async () => {
        const { result, log } = await runOnce({ script: [{ error: new ProviderError(kind, `failed: ${kind}`) }] });
        expect(result).toEqual({ reason: "error", error: `failed: ${kind}` });
        expect(await roles(log)).toEqual(["user"]);
      });
    }
  }

  for (const kind of kinds) {
    it(`a hook can turn ${kind} into a pause, and the next run continues`, async () => {
      const p = plugin("quota", (api) => api.on("error", (error) => (error.kind === kind ? { pause: "quota" } : undefined)));
      const { kernel, log } = setup({
        script: [{ error: new ProviderError(kind, "limit") }, { text: "resumed" }],
        plugins: [p],
      });
      const first = await finish(kernel.run(log, "work"));
      expect(first.result).toEqual({ reason: "paused", pause: "quota" });
      expect((await log.branch()).at(-1)).toMatchObject({ type: "paused", reason: "quota" });
      const second = await finish(kernel.run(log));
      expect(second.result.reason).toBe("done");
      expect((await log.project()).map(textOf)).toEqual(["work", "resumed"]);
    });
  }

  it("a throwing error hook falls back to ending with the error", async () => {
    const p = plugin("broken", (api) =>
      api.on("error", () => {
        throw new Error("x");
      }),
    );
    const { result } = await runOnce({ script: [{ error: new ProviderError("other", "bad") }], plugins: [p] });
    expect(result.reason).toBe("error");
  });

  it("an unexpected exception from the model client ends the run with an error", async () => {
    const { result } = await runOnce({
      script: () => {
        throw new Error("client crashed");
      },
    });
    expect(result).toEqual({ reason: "error", error: "client crashed" });
  });
});

describe("truncated tool calls", () => {
  for (const before of [0, 1, 2, 3]) {
    for (const variant of range(4)) {
      it(`a cut-off call becomes a failed tool result and the loop goes on (${before} complete calls before it, variant ${variant})`, async () => {
        const { log, result, llm } = await runOnce({
          script: [
            { toolCalls: Array.from({ length: before }, (_, index) => ({ name: "echo", args: { index }, id: `ok${index}` })), truncatedToolCall: { name: "write", id: "cut" } },
            { text: "retrying smaller" },
          ],
          tools: [echo()],
        });
        expect(result.reason).toBe("done");
        const messages = await log.project();
        const cut = messages.find((message) => message.toolCallId === "cut");
        expect(cut?.isError).toBe(true);
        expect(textOf(cut!)).toContain("cut off");
        expect(messages.filter((message) => message.role === "tool")).toHaveLength(before + 1);
        expect(llm.requests).toHaveLength(2);
      });
    }
  }
});

describe("recovery: a run can resume from any prefix of its own log", () => {
  interface Scenario {
    script: Array<{ toolCalls?: Array<{ name: string; args: unknown; id: string }>; text?: string }>;
    entryCount: number;
  }
  function scenario(seed: number): Scenario {
    const rng = createRng(seed * 31);
    const turns = rng.int(1, 3);
    const script: Scenario["script"] = [];
    let entryCount = 2; // the system patch and the user message
    for (let turn = 0; turn < turns; turn++) {
      const calls = rng.int(1, 3);
      script.push({
        toolCalls: Array.from({ length: calls }, (_, index) => ({ name: rng.chance(0.5) ? "echo" : "note", args: { turn, index }, id: `t${turn}c${index}` })),
      });
      entryCount += 1 + calls;
    }
    script.push({ text: `final ${seed}` });
    return { script, entryCount: entryCount + 1 };
  }

  const tools = () => [echo("echo"), tool("note", (args) => ({ content: text(`noted:${JSON.stringify(args)}`) }), { effect: "write" })];
  const assistantCount = (messages: Array<{ role: string }>) => messages.filter((message) => message.role === "assistant").length;

  for (const seed of range(30, 100)) {
    const { script, entryCount } = scenario(seed);
    for (let prefix = 2; prefix <= entryCount; prefix++) {
      it(`resumes after ${prefix} of ${entryCount} entries (seed ${seed})`, async () => {
        const reference = createMemoryLog({ now: () => 1000 });
        const refKernel = setup({ script: (request) => script[assistantCount(request.messages)] ?? { text: "extra" }, tools: tools(), log: reference });
        await finish(refKernel.kernel.run(reference, "start"));
        const full = await reference.branch();
        expect(full).toHaveLength(entryCount);

        const resumedLog: Log = createMemoryLog({ now: () => 1000, entries: full.slice(0, prefix) });
        const resumed = setup({ script: (request) => script[assistantCount(request.messages)] ?? { text: "extra" }, tools: tools(), log: resumedLog });
        const { result } = await finish(resumed.kernel.run(resumedLog));
        expect(result.reason).toBe("done");
        const strip = (messages: Awaited<ReturnType<Log["project"]>>) => messages.map((m) => ({ role: m.role, id: m.toolCallId, text: textOf(m) }));
        expect(strip(await resumedLog.project())).toEqual(strip(await reference.project()));
      });
    }
  }
});

describe("recovery: tools that must not be replayed", () => {
  const entries = (withStarted: boolean) => {
    const base = [
      { id: "u", parentId: null, ts: 1, type: "message", message: { role: "user", content: text("go"), ts: 1 } },
      { id: "a", parentId: "u", ts: 1, type: "message", message: { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "deploy", args: {} }], ts: 1, stop: "tool_use" } },
    ];
    return (withStarted ? [...base, { id: "s", parentId: "a", ts: 1, type: "tool_started", toolCallId: "c1", toolName: "deploy" }] : base) as never[];
  };

  for (const variant of range(10)) {
    it(`a never-replay tool that had started is marked interrupted, not run again (variant ${variant})`, async () => {
      let runs = 0;
      const deploy = tool(
        "deploy",
        () => {
          runs++;
          return { content: text("deployed") };
        },
        { effect: "exec", replay: "never" },
      );
      const log = createMemoryLog({ entries: entries(true) });
      const { kernel } = setup({ script: [{ text: "checked" }], tools: [deploy], log });
      await finish(kernel.run(log));
      const messages = await log.project();
      expect(runs).toBe(0);
      expect(messages.find((message) => message.role === "tool")?.isError).toBe(true);
      expect(textOf(messages.find((message) => message.role === "tool")!)).toContain("interrupted");
      expect(textOf(messages.at(-1)!)).toBe("checked");
    });

    it(`a never-replay tool that never started is simply run (variant ${variant})`, async () => {
      let runs = 0;
      const deploy = tool(
        "deploy",
        () => {
          runs++;
          return { content: text("deployed") };
        },
        { effect: "exec", replay: "never" },
      );
      const log = createMemoryLog({ entries: entries(false) });
      const { kernel } = setup({ script: [{ text: "ok" }], tools: [deploy], log });
      await finish(kernel.run(log));
      expect(runs).toBe(1);
    });
  }

  it("writes tool_started before running a never-replay tool that changes things", async () => {
    const seen: string[] = [];
    const log = createMemoryLog();
    const deploy = tool(
      "deploy",
      async () => {
        seen.push((await log.branch()).map((entry) => entry.type).join(","));
        return { content: text("ok") };
      },
      { effect: "exec", replay: "never" },
    );
    const { kernel } = setup({ script: [{ toolCalls: [{ name: "deploy", args: {}, id: "c" }] }, { text: "d" }], tools: [deploy], log });
    await finish(kernel.run(log, "go"));
    expect(seen[0]).toContain("tool_started");
  });

  it("does not write tool_started for read-only tools", async () => {
    const { log } = await runOnce({ script: [{ toolCalls: [{ name: "echo", args: {}, id: "c" }] }, { text: "d" }], tools: [echo()] });
    expect((await log.branch()).some((entry) => entry.type === "tool_started")).toBe(false);
  });
});
