import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, Event, LlmRequest, Message } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import type { FauxTurn } from "@sakura/testing";
import { resiliencePlugin } from "../src/index.ts";
import type { ResilienceOptions } from "../src/index.ts";

const env = { cwd: "/w", resolve: (p: string) => p, dispose: async () => undefined } as unknown as Environment;
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const cutEmpty: FauxTurn = { reasoning: "thinking and thinking", stop: "length" };
const empty: FauxTurn = { stop: "stop" };

async function run(script: FauxTurn[] | ((request: LlmRequest, index: number) => FauxTurn), options: ResilienceOptions = {}, kernelOptions: { maxTokens?: number } = {}, inputs = ["go"]) {
  const llm = createFauxClient(script);
  const events: unknown[] = [];
  const kernel = createKernel({
    llm,
    env,
    system: "s",
    tools: [{ name: "echo", description: "", parameters: {}, effect: "read", execute: async () => ({ content: [{ type: "text", text: "echoed" }] }) }],
    plugins: [resiliencePlugin(options), { name: "watch", setup: (api) => api.on("event", (event: Event) => event.type === "plugin" && events.push(event.data)) }],
    compaction: false,
    now: () => 1,
    ...(kernelOptions.maxTokens !== undefined ? { maxTokens: kernelOptions.maxTokens } : {}),
  });
  const log = createMemoryLog();
  const results = [];
  for (const input of inputs) {
    const handle = kernel.run(log, input);
    for await (const _event of handle.events) void _event;
    results.push(await handle.result);
  }
  return { llm, log, events, results };
}

describe("a reply cut off before anything was written (cut-empty)", () => {
  it("is asked again, and the answer that follows ends the run", async () => {
    const { llm, results, log } = await run([cutEmpty, { text: "the answer" }]);
    expect(results[0]).toMatchObject({ reason: "done" });
    expect(llm.requests).toHaveLength(2);
    const nudge = llm.requests[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(textOf(nudge)).toBe(
      "[auto:cut-empty] Your previous reply was cut off by the output limit before you wrote anything. Continue now: keep your reasoning short, then write your answer or make your tool call.",
    );
    expect(textOf((await log.project()).at(-1)!)).toBe("the answer");
  });

  it("the next request gets more room: the limit doubles at each retry, from 8192 when none was set", async () => {
    const { llm } = await run([cutEmpty, cutEmpty, { text: "ok" }]);
    expect(llm.requests.map((request) => request.maxTokens)).toEqual([undefined, 16384, 32768]);
  });

  it("starts from the limit that was set, and never goes beyond the cap", async () => {
    const { llm } = await run([cutEmpty, cutEmpty, { text: "ok" }], {}, { maxTokens: 10_000 });
    expect(llm.requests.map((request) => request.maxTokens)).toEqual([10_000, 20_000, 32768]);
    const high = await run([cutEmpty, { text: "ok" }], {}, { maxTokens: 40_000 });
    expect(high.llm.requests.map((request) => request.maxTokens)).toEqual([40_000, 40_000]); // already above the cap: left alone
  });

  it("gives up after 2 retries and lets the run end, saying so", async () => {
    const { llm, results, events } = await run([cutEmpty, cutEmpty, cutEmpty, { text: "never asked" }]);
    expect(llm.requests).toHaveLength(3);
    expect(results[0]).toMatchObject({ reason: "done" });
    expect(events).toEqual([
      { fix: "cut-empty", action: "ask again", attempt: 1 },
      { fix: "cut-empty", action: "ask again", attempt: 2 },
      { fix: "cut-empty", action: "gave up", attempts: 2 },
    ]);
  });

  it("a reply made of whitespace only counts as empty", async () => {
    const { llm } = await run([{ text: "  \n ", stop: "length" }, { text: "ok" }]);
    expect(llm.requests).toHaveLength(2);
  });

  it("a cut reply that has a tool call is left alone", async () => {
    const { llm } = await run([{ toolCalls: [{ name: "echo", args: {}, id: "c" }], stop: "length" }, { text: "ok" }]);
    expect(llm.requests.every((request) => !textOf(request.messages.at(-1)!).startsWith("[auto:"))).toBe(true);
  });

  it("retries are counted from the end of the conversation: progress in between gives a fresh set", async () => {
    const { llm } = await run([cutEmpty, { toolCalls: [{ name: "echo", args: {}, id: "c" }] }, cutEmpty, cutEmpty, { text: "ok" }]);
    expect(llm.requests).toHaveLength(5); // two cuts, a tool call, then two more cuts: each series had its 2 retries
  });

  it("the retry count survives a new run on the same conversation", async () => {
    const { log } = await run([cutEmpty, cutEmpty, cutEmpty, { text: "x" }]);
    const again = createKernel({ llm: createFauxClient([cutEmpty]), env, system: "s", tools: [], plugins: [resiliencePlugin()], compaction: false, now: () => 1 });
    const handle = again.run(log); // no new input: it looks at the log as it is
    for await (const _event of handle.events) void _event;
    expect((await log.project()).filter((message) => textOf(message).startsWith("[auto:")).length).toBe(2); // the two from the first run; running again does not hand out a fresh set
  });
});

describe("an empty reply (empty)", () => {
  it("is asked once, with a message that says the reply was empty", async () => {
    const { llm } = await run([empty, { text: "now I answer" }]);
    expect(llm.requests).toHaveLength(2);
    expect(textOf(llm.requests[1]!.messages.at(-1)!)).toBe("[auto:empty] Your previous reply was empty. Say what you found, or make the tool call you meant to make.");
    expect(llm.requests[1]!.maxTokens).toBeUndefined(); // more room would not help here
  });

  it("is not asked a second time", async () => {
    const { llm, events } = await run([empty, empty, { text: "never" }]);
    expect(llm.requests).toHaveLength(2);
    expect(events.at(-1)).toEqual({ fix: "empty", action: "gave up", attempts: 1 });
  });

  it("a reply that only reasoned and then stopped is empty too", async () => {
    const { llm } = await run([{ reasoning: "thought about it", stop: "stop" }, { text: "ok" }]);
    expect(llm.requests).toHaveLength(2);
  });

  it("a reply with text, or with a tool call, is not empty", async () => {
    expect((await run([{ text: "hello" }])).llm.requests).toHaveLength(1);
    expect((await run([{ toolCalls: [{ name: "echo", args: {}, id: "c" }] }, { text: "done" }])).llm.requests).toHaveLength(2);
  });
});

describe("a reply cut off in the middle of its text (cut-text)", () => {
  it("is left alone by default", async () => {
    const { llm } = await run([{ text: "half a sentence and", stop: "length" }]);
    expect(llm.requests).toHaveLength(1);
  });

  it("when switched on, is asked to continue where it stopped, with more room", async () => {
    const { llm } = await run([{ text: "half a sentence and", stop: "length" }, { text: " the rest" }], { cutText: {} });
    expect(llm.requests).toHaveLength(2);
    expect(textOf(llm.requests[1]!.messages.at(-1)!)).toBe("[auto:cut-text] Your previous reply was cut off by the output limit. Continue exactly where you stopped.");
    expect(llm.requests[1]!.maxTokens).toBe(16384);
  });
});

describe("switching fixes off and changing them", () => {
  it("each fix can be switched off on its own", async () => {
    expect((await run([cutEmpty, { text: "x" }], { cutEmpty: false })).llm.requests).toHaveLength(1);
    expect((await run([empty, { text: "x" }], { empty: false })).llm.requests).toHaveLength(1);
    // the others still work
    expect((await run([empty, { text: "x" }], { cutEmpty: false })).llm.requests).toHaveLength(2);
    expect((await run([cutEmpty, { text: "x" }], { empty: false })).llm.requests).toHaveLength(2);
  });

  it("the number of retries and the message can be changed", async () => {
    const { llm } = await run([cutEmpty, cutEmpty, cutEmpty, cutEmpty, { text: "x" }], { cutEmpty: { retries: 3, message: "Please carry on." } });
    expect(llm.requests).toHaveLength(4);
    expect(textOf(llm.requests[1]!.messages.at(-1)!)).toBe("[auto:cut-empty] Please carry on.");
  });

  it("zero retries means the fix is asked for no more than it gives up at once", async () => {
    const { llm, events } = await run([cutEmpty, { text: "x" }], { cutEmpty: { retries: 0 } });
    expect(llm.requests).toHaveLength(1);
    expect(events).toEqual([{ fix: "cut-empty", action: "gave up", attempts: 0 }]);
  });

  it("the growth and the cap of the limit can be changed; with the raising fixes off the limit is never touched", async () => {
    const { llm } = await run([cutEmpty, cutEmpty, { text: "x" }], { maxTokens: { start: 1000, growth: 3, cap: 5000 } });
    expect(llm.requests.map((request) => request.maxTokens)).toEqual([undefined, 3000, 5000]);
    const off = await run([{ text: "x", stop: "length" }, { text: "y" }], { cutEmpty: false, cutText: {}, maxTokens: { start: 1000 } });
    expect(off.llm.requests[1]!.maxTokens).toBe(2000);
    const none = await run([empty, { text: "z" }], { cutEmpty: false });
    expect(none.llm.requests[1]!.maxTokens).toBeUndefined();
  });
});

describe("what the plugin does not touch", () => {
  it("an ordinary run is exactly as without the plugin", async () => {
    const { llm, log } = await run([{ toolCalls: [{ name: "echo", args: {}, id: "c" }] }, { text: "all done" }]);
    expect(llm.requests).toHaveLength(2);
    expect((await log.project()).some((message) => textOf(message).startsWith("[auto:"))).toBe(false);
  });

  it("a user message that merely looks like a notice does not count as one", async () => {
    const { llm } = await run([empty, { text: "ok" }], {}, {}, ["[auto: not ours"]);
    expect(llm.requests).toHaveLength(2); // asked once as usual
  });

  it("names itself and says what it compensates", () => {
    const plugin = resiliencePlugin();
    expect(plugin.name).toBe("resilience");
    expect(plugin.compensates).toMatch(/small, common ways/);
  });
});
