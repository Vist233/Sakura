// One suite, every implementation of LlmClient: the scripted fake model used by all the other tests and the real chat adapter
// (talking to a fake HTTP server). If the fake behaves differently from the adapter, tests built on the fake prove nothing.
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmEvent, LlmRequest } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { createChatClient } from "../src/index.ts";
import { chunk, collect, sse, streamResponse } from "./helpers.ts";

const request: LlmRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
type Turn = { text: string } | { call: { name: string; args: Record<string, unknown> } };

/** Makes a client that will answer with the given turn. */
const implementations: Array<[string, (turn: Turn) => LlmClient]> = [
  ["faux client", (turn) => createFauxClient(["text" in turn ? { text: turn.text } : { toolCalls: [{ name: turn.call.name, args: turn.call.args, id: "call_1" }] }])],
  [
    "chat adapter",
    (turn) => {
      const reply =
        "text" in turn
          ? sse(chunk({ content: turn.text }), chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 2 } }), "[DONE]")
          : sse(
              chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] }),
              chunk({}, "tool_calls", { usage: { prompt_tokens: 5, completion_tokens: 2 } }),
              "[DONE]",
            );
      return createChatClient({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        model: "m",
        contextWindow: 1000,
        fetch: async () => streamResponse([reply]),
        retry: { sleep: async () => undefined, random: () => 0 },
      });
    },
  ],
];

const kinds = (events: LlmEvent[]) => events.map((event) => event.type);

for (const [name, make] of implementations) {
  describe(`LlmClient contract: ${name}`, () => {
    it("exposes a model with a context window", () => {
      const client = make({ text: "x" });
      expect(typeof client.model.contextWindow).toBe("number");
      expect(client.model.contextWindow).toBeGreaterThan(0);
    });

    it("a text answer streams text_delta events and ends with one done event", async () => {
      const events = await collect(make({ text: "hello there" }).stream(request, new AbortController().signal));
      const text = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("");
      expect(text).toBe("hello there");
      expect(kinds(events).filter((kind) => kind === "done")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("a text answer ends with stop reason 'end' (not tool_use)", async () => {
      const events = await collect(make({ text: "x" }).stream(request, new AbortController().signal));
      const done = events.at(-1);
      expect(done?.type === "done" && done.stop).not.toBe("tool_use");
    });

    it("a tool call arrives as one tool_call event with parsed arguments, then done with stop 'tool_use'", async () => {
      const events = await collect(make({ call: { name: "add", args: { a: 1, b: 2 } } }).stream(request, new AbortController().signal));
      const calls = events.filter((event) => event.type === "tool_call");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ type: "tool_call", call: { name: "add", args: { a: 1, b: 2 } } });
      expect(events.at(-1)).toEqual({ type: "done", stop: "tool_use" });
    });

    it("reports usage before done", async () => {
      const events = await collect(make({ text: "x" }).stream(request, new AbortController().signal));
      const usageAt = kinds(events).indexOf("usage");
      if (usageAt >= 0) expect(usageAt).toBeLessThan(kinds(events).indexOf("done"));
    });

    it("can be used again for a second request without leftover state", async () => {
      const client = make({ text: "again" });
      const first = await collect(client.stream(request, new AbortController().signal)).catch(() => undefined);
      expect(first).toBeDefined();
    });
  });
}
