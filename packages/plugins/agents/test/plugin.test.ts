import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, Event, Message, Tool } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import type { FauxScript } from "@sakura/testing";
import { agentsPlugin } from "../src/index.ts";
import type { AgentDefinition, AgentsOptions } from "../src/index.ts";

const env = {
  cwd: "/w",
  resolve: (p: string) => p,
  readFile: async () => new Uint8Array(),
  writeFile: async () => undefined,
  stat: async () => undefined,
  list: async () => [],
  exec: async () => ({ exitCode: 0, output: "", timedOut: false }),
  spawn: () => {
    throw new Error("n/a");
  },
  dispose: async () => undefined,
} as Environment;
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const echo: Tool = { name: "echo", description: "", parameters: {}, effect: "read", execute: async () => ({ content: [{ type: "text", text: "echoed" }] }) };

interface ChildLog {
  requests: Array<ReturnType<typeof createFauxClient>["requests"]>;
  created: Array<{ definition: AgentDefinition; maxTurns?: number; model?: string }>;
}

function harness(options: { child: (definition: AgentDefinition, index: number) => FauxScript; parent: FauxScript; options?: Partial<AgentsOptions>; agents?: AgentDefinition[] }) {
  const seen: ChildLog = { requests: [], created: [] };
  const plugin = agentsPlugin({
    agents: options.agents ?? [],
    createChild: (request) => {
      const index = seen.created.length;
      seen.created.push(request);
      const llm = createFauxClient(options.child(request.definition, index));
      seen.requests.push(llm.requests);
      return createKernel({ llm, env, system: "child system", tools: [echo], compaction: false, now: () => 1 });
    },
    ...options.options,
  });
  const parentLlm = createFauxClient(options.parent);
  const kernel = createKernel({ llm: parentLlm, env, system: "parent", tools: [echo], plugins: [plugin], compaction: false, now: () => 1 });
  const log = createMemoryLog();
  const run = async (input: string | undefined = "go") => {
    const handle = kernel.run(log, input);
    const events: Event[] = [];
    const reading = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    const result = await handle.result;
    await reading;
    return { result, events, handle };
  };
  const toolResults = async () => (await log.project()).filter((message) => message.role === "tool");
  return { seen, parentLlm, kernel, log, run, toolResults };
}
const delegateCall = (args: Record<string, unknown>, id = "d1") => ({ toolCalls: [{ name: "delegate", args, id }] });

describe("delegate in the foreground", () => {
  for (const seed of range(15)) {
    it(`returns the sub-agent's final answer (seed ${seed})`, async () => {
      const h = harness({ child: () => [{ text: `result ${seed}` }], parent: [delegateCall({ message: `task ${seed}` }), { text: "done" }] });
      await h.run();
      const result = (await h.toolResults())[0]!;
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain(`result ${seed}`);
      expect(textOf(result)).toContain("general-1");
    });
  }

  for (const seed of range(10, 100)) {
    it(`starts the sub-agent with a fresh context: only the task message (seed ${seed})`, async () => {
      const h = harness({ child: () => [{ text: "ok" }], parent: [delegateCall({ message: `just this ${seed}` }), { text: "done" }] });
      await h.log.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "earlier parent talk" }], ts: 1 } });
      await h.run("start");
      const request = h.seen.requests[0]![0]!;
      expect(request.messages.map(textOf)).toEqual([`just this ${seed}`]);
      expect(request.system).toBe("child system");
    });
  }

  it("the sub-agent can use tools and its answer comes back after it finishes", async () => {
    const h = harness({ child: () => [{ toolCalls: [{ name: "echo", args: {}, id: "t" }] }, { text: "used the tool" }], parent: [delegateCall({ message: "x" }), { text: "done" }] });
    await h.run();
    expect(textOf((await h.toolResults())[0]!)).toContain("used the tool");
  });

  it("reports a sub-agent that failed", async () => {
    const h = harness({
      child: () => () => {
        throw new Error("child broke");
      },
      parent: [delegateCall({ message: "x" }), { text: "done" }],
    });
    await h.run();
    const result = (await h.toolResults())[0]!;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ended early");
  });

  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["no message", {}, "'message'"],
    ["an empty message", { message: "  " }, "'message'"],
    ["a number as message", { message: 5 }, "'message'"],
    ["an unknown kind", { message: "x", agent: "nope" }, "Unknown kind"],
    ["an unknown id", { message: "x", to: "ghost-9" }, "no sub-agent"],
  ];
  for (const [name, args, message] of invalid) {
    for (const variant of range(2)) {
      it(`rejects ${name} (variant ${variant})`, async () => {
        const h = harness({ child: () => [{ text: "ok" }], parent: [delegateCall(args), { text: "done" }] });
        await h.run();
        const result = (await h.toolResults())[0]!;
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(message);
        expect(h.seen.created).toHaveLength(0);
      });
    }
  }

  it("lets the parent pick a named kind of sub-agent and passes its settings on", async () => {
    const agents: AgentDefinition[] = [{ name: "reviewer", description: "reviews code", maxTurns: 7, model: "big-model" }];
    const h = harness({ child: () => [{ text: "ok" }], agents, parent: [delegateCall({ message: "check it", agent: "reviewer" }), { text: "done" }] });
    await h.run();
    expect(h.seen.created[0]).toMatchObject({ definition: { name: "reviewer" }, maxTurns: 7, model: "big-model" });
  });
  it("max_turns from the call overrides the definition", async () => {
    const h = harness({ child: () => [{ text: "ok" }], agents: [{ name: "w", description: "", maxTurns: 7 }], parent: [delegateCall({ message: "x", agent: "w", max_turns: 3 }), { text: "done" }] });
    await h.run();
    expect(h.seen.created[0]?.maxTurns).toBe(3);
  });
  it("describes the available kinds in the tool definition and lists the four sections", async () => {
    const h = harness({ child: () => [], agents: [{ name: "reviewer", description: "reviews code" }], parent: [{ text: "hi" }] });
    await h.run();
    const declared = h.parentLlm.requests[0]!.tools.find((tool) => tool.name === "delegate")!;
    expect(JSON.stringify(declared.parameters)).toContain("reviewer (reviews code)");
    for (const heading of ["When to delegate", "When to do it yourself", "How to design the subtask", "Do not wait reflexively"]) expect(declared.description).toContain(heading);
  });
});

describe("follow-ups with to", () => {
  it("continues the same sub-agent conversation", async () => {
    const h = harness({
      child: () => [{ text: "first answer" }, { text: "second answer" }],
      parent: [delegateCall({ message: "start" }, "a"), delegateCall({ message: "continue", to: "general-1" }, "b"), { text: "done" }],
    });
    await h.run();
    expect(textOf((await h.toolResults())[1]!)).toContain("second answer");
    expect(h.seen.created).toHaveLength(1);
    expect(h.seen.requests[0]![1]!.messages.map(textOf)).toEqual(["start", "first answer", "continue"]);
  });
  it("queues the message for a sub-agent that is still running", async () => {
    const h = harness({
      child: () => (request) => (request.messages.length === 1 ? { text: "a".repeat(5), chunkSize: 1 } : { text: "after queue" }),
      parent: [delegateCall({ message: "start", background: true }, "a"), delegateCall({ message: "also this", to: "general-1" }, "b"), { text: "done" }],
    });
    await h.run();
    expect(textOf((await h.toolResults())[1]!)).toMatch(/queued|finished/);
  });
});

describe("background sub-agents and agent_view", () => {
  it("the parent is told when a background sub-agent ends, without polling", async () => {
    const h = harness({ child: () => [{ text: "all done" }], parent: [delegateCall({ message: "work", background: true }), { text: "waiting" }] });
    await h.run();
    for (let tries = 0; tries < 50 && h.kernel.pending(h.log).signals.length === 0; tries++) await delay(2);
    const pending = h.kernel.pending(h.log);
    expect(pending.watching).toEqual([]);
    expect(pending.signals).toHaveLength(1);
    expect(pending.signals[0]).toContain("general-1 finished its work");
  });

  it("a stopped background sub-agent is reported as stopped", async () => {
    const h = harness({
      child: () => [{ hang: true }],
      parent: [delegateCall({ message: "slow", background: true }), { toolCalls: [{ name: "agent_stop", args: { id: "general-1" }, id: "s" }] }, { text: "ok" }],
    });
    await h.run();
    const told = (await h.log.branch()).some((entry) => entry.type === "custom_message" && entry.customType === "signal" && JSON.stringify(entry.content).includes("stopped"));
    for (let tries = 0; tries < 50 && !told && h.kernel.pending(h.log).signals.length === 0; tries++) await delay(2);
    const reported = told || (h.kernel.pending(h.log).signals[0] ?? "").includes("stopped");
    expect(reported).toBe(true);
  });

  it("a foreground delegate adds nothing to watch", async () => {
    const h = harness({ child: () => [{ text: "r" }], parent: [delegateCall({ message: "work" }), { text: "done" }] });
    await h.run();
    expect(h.kernel.pending(h.log)).toEqual({ signals: [], watching: [] });
  });

  it("returns at once and the sub-agent finishes on its own", async () => {
    const h = harness({
      child: () => [{ text: "background result" }],
      parent: [delegateCall({ message: "work", background: true }), { toolCalls: [{ name: "agent_view", args: { id: "general-1", wait_seconds: 5 }, id: "v" }] }, { text: "done" }],
    });
    await h.run();
    const [started, viewed] = await h.toolResults();
    expect(textOf(started!)).toContain("in the background");
    expect(textOf(viewed!)).toContain("background result");
    expect(textOf(viewed!)).toContain("idle");
  });

  it("without wait_seconds shows the state right now", async () => {
    const h = harness({
      child: () => [{ hang: true }],
      parent: [delegateCall({ message: "slow", background: true }), { toolCalls: [{ name: "agent_view", args: { id: "general-1" }, id: "v" }] }, { text: "done" }],
    });
    await h.run();
    expect(textOf((await h.toolResults())[1]!)).toContain("running");
  });

  it("lists every sub-agent when no id is given", async () => {
    const h = harness({
      child: () => [{ text: "ok" }],
      parent: [delegateCall({ message: "one" }, "a"), delegateCall({ message: "two" }, "b"), { toolCalls: [{ name: "agent_view", args: {}, id: "v" }] }, { text: "done" }],
    });
    await h.run();
    const list = textOf((await h.toolResults())[2]!);
    expect(list).toContain("general-1");
    expect(list).toContain("general-2");
  });
  it("says so when there are none and when the id is wrong", async () => {
    const h = harness({
      child: () => [],
      parent: [
        {
          toolCalls: [
            { name: "agent_view", args: {}, id: "a" },
            { name: "agent_view", args: { id: "x" }, id: "b" },
          ],
        },
        { text: "done" },
      ],
    });
    await h.run();
    const [none, wrong] = await h.toolResults();
    expect(textOf(none!)).toBe("There are no sub-agents.");
    expect(wrong!.isError).toBe(true);
  });
  for (const last of [1, 2, 5]) {
    it(`last=${last} limits the steps shown`, async () => {
      const h = harness({
        child: () => [{ toolCalls: [{ name: "echo", args: {}, id: "t1" }] }, { toolCalls: [{ name: "echo", args: {}, id: "t2" }] }, { text: "end" }],
        parent: [delegateCall({ message: "x" }), { toolCalls: [{ name: "agent_view", args: { id: "general-1", last }, id: "v" }] }, { text: "done" }],
      });
      await h.run();
      const lines = textOf((await h.toolResults())[1]!)
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("("));
      expect(lines.length).toBeLessThanOrEqual(last);
    });
  }
});

describe("limits", () => {
  for (const limit of [1, 2, 3, 5]) {
    it(`refuses a new sub-agent beyond ${limit} registered`, async () => {
      const calls = Array.from({ length: limit + 1 }, (_, index) => delegateCall({ message: `t${index}` }, `d${index}`));
      const h = harness({ child: () => () => ({ text: "ok" }), parent: [...calls, { text: "done" }], options: { maxRegistered: limit } });
      await h.run();
      const results = await h.toolResults();
      expect(results.slice(0, limit).every((result) => !result.isError)).toBe(true);
      expect(results[limit]!.isError).toBe(true);
      expect(textOf(results[limit]!)).toContain(`${limit} sub-agents`);
      expect(h.seen.created).toHaveLength(limit);
    });
  }
  for (const limit of [1, 2, 3]) {
    it(`refuses a new background sub-agent beyond ${limit} running`, async () => {
      const calls = Array.from({ length: limit + 1 }, (_, index) => delegateCall({ message: `t${index}`, background: true }, `d${index}`));
      const h = harness({ child: () => [{ hang: true }], parent: [...calls, { text: "done" }], options: { maxRunning: limit } });
      await h.run();
      const results = await h.toolResults();
      expect(results[limit]!.isError).toBe(true);
      expect(textOf(results[limit]!)).toContain("running");
      expect(h.seen.created).toHaveLength(limit);
    });
  }
  it("a finished sub-agent no longer counts as running", async () => {
    const calls = [delegateCall({ message: "a" }, "1"), delegateCall({ message: "b" }, "2"), delegateCall({ message: "c" }, "3")];
    const h = harness({ child: () => () => ({ text: "ok" }), parent: [...calls, { text: "done" }], options: { maxRunning: 1 } });
    await h.run();
    expect((await h.toolResults()).every((result) => !result.isError)).toBe(true);
  });
  it("the default limits are 20 registered and 8 running", async () => {
    const calls = Array.from({ length: 21 }, (_, index) => delegateCall({ message: `t${index}` }, `d${index}`));
    const h = harness({ child: () => () => ({ text: "ok" }), parent: [...calls, { text: "done" }] });
    await h.run();
    expect(h.seen.created).toHaveLength(20);
    const running = harness({
      child: () => [{ hang: true }],
      parent: [...Array.from({ length: 9 }, (_, index) => delegateCall({ message: `t${index}`, background: true }, `d${index}`)), { text: "done" }],
    });
    await running.run();
    expect(running.seen.created).toHaveLength(8);
  });
});

describe("no nesting and stopping", () => {
  it("a sub-agent does not get delegate because its kernel has no agents plugin", async () => {
    const h = harness({ child: () => [{ text: "ok" }], parent: [delegateCall({ message: "x" }), { text: "done" }] });
    await h.run();
    expect(h.seen.requests[0]![0]!.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });
  for (const variant of range(4)) {
    it(`agent_stop stops a running sub-agent and keeps its log (variant ${variant})`, async () => {
      const h = harness({
        child: () => [{ hang: true }],
        parent: [
          delegateCall({ message: "x", background: true }),
          { toolCalls: [{ name: "agent_stop", args: { id: "general-1" }, id: "s" }] },
          { toolCalls: [{ name: "agent_view", args: { id: "general-1" }, id: "v" }] },
          { text: "done" },
        ],
      });
      await h.run();
      const results = await h.toolResults();
      expect(textOf(results[1]!)).toContain("Stopped");
      expect(textOf(results[2]!)).toContain("stopped");
      expect(textOf(results[2]!)).toContain("user: x");
    });
  }
  it("stopping something that is not running says so", async () => {
    const h = harness({
      child: () => [{ text: "ok" }],
      parent: [
        delegateCall({ message: "x" }),
        {
          toolCalls: [
            { name: "agent_stop", args: { id: "general-1" }, id: "s" },
            { name: "agent_stop", args: { id: "nope" }, id: "t" },
            { name: "agent_stop", args: {}, id: "u" },
          ],
        },
        { text: "done" },
      ],
    });
    await h.run();
    const results = await h.toolResults();
    expect(textOf(results[1]!)).toContain("not running");
    expect(results[2]!.isError).toBe(true);
    expect(results[3]!.isError).toBe(true);
  });
  it("cancelling the parent stops a sub-agent it is waiting for", async () => {
    const childLogs: Array<ReturnType<typeof createMemoryLog>> = [];
    const h = harness({
      child: () => [{ hang: true }],
      parent: [delegateCall({ message: "x" }), { text: "never" }],
      options: {
        openLog: async () => {
          const log = createMemoryLog();
          childLogs.push(log);
          return log;
        },
      },
    });
    const handle = h.kernel.run(h.log, "go");
    for await (const _event of (async function* () {
      await delay(60);
      yield 0;
    })())
      void _event;
    handle.cancel();
    const result = await Promise.race([handle.result, delay(3000).then(() => "timeout" as const)]);
    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({ reason: "cancelled" });
    expect((await childLogs[0]!.project()).map(textOf)).toEqual(["x"]);
  });
});

describe("sub-agent logs", () => {
  it("use the log the caller provides, one per sub-agent", async () => {
    const logs = new Map<string, ReturnType<typeof createMemoryLog>>();
    const h = harness({
      child: () => () => ({ text: "ok" }),
      parent: [delegateCall({ message: "a" }, "1"), delegateCall({ message: "b" }, "2"), { text: "done" }],
      options: {
        openLog: async (id) => {
          const log = createMemoryLog();
          logs.set(id, log);
          return log;
        },
      },
    });
    await h.run();
    expect([...logs.keys()]).toEqual(["general-1", "general-2"]);
    expect((await logs.get("general-1")!.project()).map(textOf)).toEqual(["a", "ok"]);
  });
});
