import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { echo, finish, roles, runOnce, setup, text, textOf, tool, delay } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);

describe("loop: plain replies", () => {
  for (const seed of range(30)) {
    it(`answers with text and ends (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const reply = `reply ${rng.int(0, 99999)} ${"x".repeat(rng.int(0, 40))}`;
      const { log, result, events, llm } = await runOnce({ script: [{ text: reply, chunkSize: rng.int(1, 9) }] }, `question ${seed}`);
      expect(result).toEqual({ reason: "done" });
      expect((await log.project()).map(textOf)).toEqual([`question ${seed}`, reply]);
      expect(events[0]).toEqual({ type: "run_start" });
      expect(events.at(-1)).toEqual({ type: "run_end", reason: "done" });
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]?.system).toBe("system prompt");
    });
  }

  it("records usage and stop reason on the assistant message", async () => {
    const { log } = await runOnce({ script: [{ text: "hi", usage: { input: 11, output: 3 } }] });
    const assistant = (await log.project())[1];
    expect(assistant?.usage).toMatchObject({ input: 11, output: 3 });
    expect(assistant?.stop).toBe("stop");
  });

  it("passes max tokens and the tool list to the model", async () => {
    const { llm } = await runOnce({ script: [{ text: "a" }], tools: [echo("one"), echo("two")], maxTokens: 777 });
    expect(llm.requests[0]?.maxTokens).toBe(777);
    expect(llm.requests[0]?.tools.map((declared) => declared.name)).toEqual(["one", "two"]);
  });

  it("handles an empty model reply without hanging", async () => {
    const { result, log } = await runOnce({ script: [{}] });
    expect(result.reason).toBe("done");
    expect(await roles(log)).toEqual(["user", "assistant"]);
  });
});

describe("loop: tool calls", () => {
  for (const seed of range(40, 100)) {
    it(`runs tool calls and feeds the results back (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const calls = rng.int(1, 5);
      const turnsWithTools = rng.int(1, 3);
      const script = [
        ...Array.from({ length: turnsWithTools }, (_, turn) => ({
          toolCalls: Array.from({ length: calls }, (_, index) => ({ name: "echo", args: { turn, index }, id: `t${turn}c${index}` })),
        })),
        { text: "all done" },
      ];
      const { log, result, llm } = await runOnce({ script, tools: [echo()] });
      expect(result.reason).toBe("done");
      expect(llm.requests).toHaveLength(turnsWithTools + 1);
      const messages = await log.project();
      expect(messages).toHaveLength(1 + turnsWithTools * (1 + calls) + 1);
      const lastToolBatch = messages.filter((message) => message.role === "tool").slice(-calls);
      expect(lastToolBatch.map(textOf)).toEqual(Array.from({ length: calls }, (_, index) => `echo:${JSON.stringify({ turn: turnsWithTools - 1, index })}`));
      expect(lastToolBatch.map((message) => message.toolCallId)).toEqual(Array.from({ length: calls }, (_, index) => `t${turnsWithTools - 1}c${index}`));
      expect(textOf(messages.at(-1)!)).toBe("all done");
    });
  }
});

describe("loop: tool errors", () => {
  const failures: Array<[string, () => ReturnType<typeof tool>, string]> = [
    [
      "throws",
      () =>
        tool("bad", () => {
          throw new Error("boom");
        }),
      "boom",
    ],
    [
      "rejects",
      () =>
        tool("bad", async () => {
          throw new Error("rejected");
        }),
      "rejected",
    ],
    ["returns isError", () => tool("bad", () => ({ content: text("nope"), isError: true })), "nope"],
  ];
  for (const [name, make, expected] of failures) {
    for (const variant of range(8)) {
      it(`reports a tool that ${name} as an error result (variant ${variant})`, async () => {
        const { log } = await runOnce({
          script: [{ toolCalls: [{ name: "bad", args: { variant }, id: "x" }] }, { text: "ok" }],
          tools: [make()],
        });
        const result = (await log.project()).find((message) => message.role === "tool");
        expect(result?.isError).toBe(true);
        expect(textOf(result!)).toContain(expected);
      });
    }
  }

  for (const variant of range(6)) {
    it(`answers a call to an unknown tool with a tool error (variant ${variant})`, async () => {
      const { log, result } = await runOnce({ script: [{ toolCalls: [{ name: `missing${variant}`, args: {}, id: "m" }] }, { text: "fine" }] });
      const answer = (await log.project()).find((message) => message.role === "tool");
      expect(answer?.isError).toBe(true);
      expect(textOf(answer!)).toContain("not available");
      expect(result.reason).toBe("done");
    });
  }
});

describe("loop: scheduling", () => {
  for (const seed of range(15, 200)) {
    it(`read-only tools run in parallel (seed ${seed})`, async () => {
      const count = 2 + (seed % 4);
      let running = 0;
      let peak = 0;
      const slow = tool("slow", async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(15);
        running--;
        return { content: text("ok") };
      });
      await runOnce({
        script: [{ toolCalls: Array.from({ length: count }, (_, index) => ({ name: "slow", args: {}, id: `c${index}` })) }, { text: "d" }],
        tools: [slow],
      });
      expect(peak).toBe(count);
    });
  }

  for (const seed of range(15, 300)) {
    it(`write tools run one at a time (seed ${seed})`, async () => {
      const count = 2 + (seed % 4);
      let running = 0;
      let peak = 0;
      const order: string[] = [];
      const write = tool(
        "write",
        async (args) => {
          running++;
          peak = Math.max(peak, running);
          order.push((args as { n: number }).n.toString());
          await delay(5);
          running--;
          return { content: text("ok") };
        },
        { effect: "write" },
      );
      await runOnce({
        script: [{ toolCalls: Array.from({ length: count }, (_, index) => ({ name: "write", args: { n: index }, id: `c${index}` })) }, { text: "d" }],
        tools: [write],
      });
      expect(peak).toBe(1);
      expect(order).toEqual(Array.from({ length: count }, (_, index) => String(index)));
    });
  }

  it("a serial tool waits for parallel tools started before it", async () => {
    const events: string[] = [];
    const read = tool("read", async () => {
      await delay(20);
      events.push("read done");
      return { content: text("r") };
    });
    const write = tool(
      "write",
      () => {
        events.push("write start");
        return { content: text("w") };
      },
      { effect: "write" },
    );
    await runOnce({
      script: [
        {
          toolCalls: [
            { name: "read", args: {}, id: "a" },
            { name: "write", args: {}, id: "b" },
          ],
        },
        { text: "d" },
      ],
      tools: [read, write],
    });
    expect(events).toEqual(["read done", "write start"]);
  });
});

describe("loop: single entry for run, resume and follow-up", () => {
  it("follow-up: a second run continues the same log", async () => {
    const { kernel, log } = setup({ script: [{ text: "first" }, { text: "second" }] });
    await finish(kernel.run(log, "one"));
    await finish(kernel.run(log, "two"));
    expect((await log.project()).map(textOf)).toEqual(["one", "first", "two", "second"]);
  });

  it("running with no input and a finished reply does nothing", async () => {
    const { kernel, log, llm } = setup({ script: [{ text: "first" }] });
    await finish(kernel.run(log, "one"));
    const outcome = await finish(kernel.run(log));
    expect(outcome.result.reason).toBe("done");
    expect(llm.requests).toHaveLength(1);
  });

  it("running with no input and an unanswered user message asks the model", async () => {
    const { kernel, log, llm } = setup({ script: [{ text: "answer" }] });
    await log.append({ type: "message", message: { role: "user", content: text("hello"), ts: 1 } });
    await finish(kernel.run(log));
    expect(llm.requests).toHaveLength(1);
    expect((await log.project()).map(textOf)).toEqual(["hello", "answer"]);
  });

  it("refuses two active runs on the same log", async () => {
    const { kernel, log } = setup({ script: [{ hang: true }] });
    const first = kernel.run(log, "a");
    expect(() => kernel.run(log, "b")).toThrow("active run");
    first.cancel();
    await first.result;
    expect(() => kernel.run(log, "c")).not.toThrow();
  });

  it("accepts content blocks as input", async () => {
    const { kernel, log } = setup({ script: [{ text: "seen" }] });
    await finish(
      kernel.run(log, [
        { type: "text", text: "block" },
        { type: "image", mediaType: "image/png", ref: "a.png" },
      ]),
    );
    expect((await log.project())[0]?.content).toHaveLength(2);
  });
});

describe("loop: events", () => {
  for (const seed of range(20, 400)) {
    it(`emits events in a consistent order (seed ${seed})`, async () => {
      const calls = seed % 3;
      const script = [...(calls ? [{ toolCalls: Array.from({ length: calls }, (_, index) => ({ name: "echo", args: {}, id: `c${index}` })) }] : []), { text: "x" }];
      const { events } = await runOnce({ script, tools: [echo()] });
      const types = events.map((event) => event.type);
      expect(types[0]).toBe("run_start");
      expect(types.at(-1)).toBe("run_end");
      expect(types.filter((type) => type === "turn_start")).toHaveLength(types.filter((type) => type === "turn_end").length);
      expect(types.filter((type) => type === "tool_start")).toHaveLength(calls);
      expect(types.filter((type) => type === "tool_end")).toHaveLength(calls);
      for (let index = 0; index < events.length; index++) {
        if (events[index]?.type === "tool_end") {
          expect(types.slice(0, index).includes("tool_start")).toBe(true);
        }
      }
    });
  }
});
