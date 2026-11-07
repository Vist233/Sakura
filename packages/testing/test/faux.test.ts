import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import type { LlmEvent, LlmRequest } from "@sakura/kernel";
import { createFauxClient } from "../src/index.ts";

const request = (text = "hi"): LlmRequest => ({
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text }], ts: 1 }],
  tools: [],
});

async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("faux client", () => {
  it("replays one turn per request and records the requests", async () => {
    const client = createFauxClient([{ text: "one" }, { text: "two" }]);
    const first = await collect(client.stream(request("a"), new AbortController().signal));
    const second = await collect(client.stream(request("b"), new AbortController().signal));
    expect(first[0]).toEqual({ type: "text_delta", delta: "one" });
    expect(second[0]).toEqual({ type: "text_delta", delta: "two" });
    expect(client.requests).toHaveLength(2);
  });

  for (const size of [1, 2, 3, 5, 7]) {
    it(`splits text into chunks of ${size}`, async () => {
      const client = createFauxClient([{ text: "abcdefghij", chunkSize: size }]);
      const events = await collect(client.stream(request(), new AbortController().signal));
      const deltas = events.filter((event) => event.type === "text_delta").map((event) => (event as { delta: string }).delta);
      expect(deltas.join("")).toBe("abcdefghij");
      expect(deltas).toHaveLength(Math.ceil(10 / size));
    });
  }

  it("ends with tool_use when there are tool calls and stop otherwise", async () => {
    const withCalls = createFauxClient([{ toolCalls: [{ name: "read", args: {} }] }]);
    const without = createFauxClient([{ text: "x" }]);
    expect((await collect(withCalls.stream(request(), new AbortController().signal))).at(-1)).toEqual({ type: "done", stop: "tool_use" });
    expect((await collect(without.stream(request(), new AbortController().signal))).at(-1)).toEqual({ type: "done", stop: "stop" });
  });

  it("gives tool calls stable ids", async () => {
    const client = createFauxClient([
      {
        toolCalls: [
          { name: "a", args: 1 },
          { name: "b", args: 2, id: "mine" },
        ],
      },
    ]);
    const calls = (await collect(client.stream(request(), new AbortController().signal))).filter((event) => event.type === "tool_call");
    expect(calls.map((event) => (event as { call: { id: string } }).call.id)).toEqual(["call_1_1", "mine"]);
  });

  it("reports a truncated tool call with stop length", async () => {
    const client = createFauxClient([{ truncatedToolCall: { name: "write" } }]);
    const events = await collect(client.stream(request(), new AbortController().signal));
    expect(events.some((event) => event.type === "tool_call_truncated")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", stop: "length" });
  });

  it("fails with the scripted provider error", async () => {
    const client = createFauxClient([{ error: new ProviderError("quota", "no credit") }]);
    await expect(collect(client.stream(request(), new AbortController().signal))).rejects.toMatchObject({ kind: "quota" });
  });

  it("hangs until aborted", async () => {
    const client = createFauxClient([{ hang: true }]);
    const controller = new AbortController();
    const pending = collect(client.stream(request(), controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails loudly when the script runs out", async () => {
    const client = createFauxClient([]);
    await expect(collect(client.stream(request(), new AbortController().signal))).rejects.toThrow("no turn for request 1");
  });

  it("accepts a function script that looks at the request", async () => {
    const client = createFauxClient((req) => ({ text: `saw ${req.messages.length}` }));
    const events = await collect(client.stream(request(), new AbortController().signal));
    expect(events[0]).toEqual({ type: "text_delta", delta: "saw 1" });
  });

  it("lets a turn override the usage numbers", async () => {
    const client = createFauxClient([{ text: "x", usage: { input: 999 } }]);
    const usage = (await collect(client.stream(request(), new AbortController().signal))).find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { input: 999 } });
  });
});
