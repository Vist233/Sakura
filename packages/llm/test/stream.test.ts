import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { defaultCompat } from "../src/chat/compat.ts";
import { normalizeUsage, parseChatStream, sseData } from "../src/chat/stream.ts";
import { bytesStream, chunk, collect, splitBytes, sse, textOfEvents } from "./helpers.ts";

const compat = { ...defaultCompat, vendor: "test" };
const parse = (pieces: Array<string | Uint8Array>) => collect(parseChatStream(bytesStream(pieces), compat));

const SAMPLE = sse(chunk({ content: "Héllo " }), chunk({ content: "wörld 你好" }), chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 4 } }), "[DONE]");
const SAMPLE_BYTES = new TextEncoder().encode(SAMPLE).length;

describe("sse: data lines survive any split of the bytes", () => {
  for (let offset = 1; offset < SAMPLE_BYTES; offset += 3) {
    it(`split at byte ${offset}`, async () => {
      const events = await parse(splitBytes(SAMPLE, [offset]));
      expect(textOfEvents(events)).toBe("Héllo wörld 你好");
      expect(events.at(-1)).toEqual({ type: "done", stop: "stop" });
    });
  }

  for (const seed of Array.from({ length: 20 }, (_, index) => index + 1)) {
    it(`split at many random places (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const offsets = Array.from({ length: rng.int(2, 25) }, () => rng.int(1, SAMPLE_BYTES - 1));
      const events = await parse(splitBytes(SAMPLE, offsets));
      expect(textOfEvents(events)).toBe("Héllo wörld 你好");
    });
  }

  it("accepts CRLF line endings, comments and a missing final blank line", async () => {
    const lines: string[] = [];
    for await (const data of sseData(bytesStream([": keep-alive\r\ndata: one\r\n\r\ndata: two"]))) lines.push(data);
    expect(lines).toEqual(["one", "two"]);
  });

  it("ignores event and id fields", async () => {
    const lines: string[] = [];
    for await (const data of sseData(bytesStream(["event: message\nid: 7\ndata: x\n\n"]))) lines.push(data);
    expect(lines).toEqual(["x"]);
  });
});

describe("stream: text, reasoning, usage, stop reasons", () => {
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
    for (const variant of [1, 2, 3]) {
      it(`collects reasoning from ${field} (variant ${variant})`, async () => {
        const events = await parse([sse(chunk({ [field]: "think " }), chunk({ [field]: "more" }), chunk({ content: "answer" }), chunk({}, "stop"), "[DONE]")]);
        expect(events.filter((event) => event.type === "reasoning_delta")).toHaveLength(2);
        expect(events.find((event) => event.type === "provider")).toEqual({ type: "provider", vendor: "test", data: { reasoning: "think more" } });
        expect(textOfEvents(events)).toBe("answer");
      });
    }
  }

  const stops: Array<[string, string]> = [
    ["stop", "stop"],
    ["length", "length"],
    ["tool_calls", "tool_use"],
    ["content_filter", "stop"],
  ];
  for (const [finish, expected] of stops) {
    for (const variant of [1, 2, 3]) {
      it(`maps finish_reason ${finish} to ${expected} (variant ${variant})`, async () => {
        const events = await parse([sse(chunk({ content: "x" }), chunk({}, finish), "[DONE]")]);
        expect(events.at(-1)).toEqual({ type: "done", stop: expected });
      });
    }
  }

  it("works without a [DONE] marker when finish_reason arrived", async () => {
    const events = await parse([sse(chunk({ content: "x" }), chunk({}, "stop"))]);
    expect(events.at(-1)).toEqual({ type: "done", stop: "stop" });
  });

  it("fails as a network error when the stream ends early", async () => {
    await expect(parse([sse(chunk({ content: "partial" }))])).rejects.toMatchObject({ kind: "network" });
  });

  it("fails on a malformed chunk", async () => {
    await expect(parse(["data: {not json\n\n"])).rejects.toBeInstanceOf(ProviderError);
  });

  it("surfaces an error object sent inside the stream", async () => {
    await expect(parse([sse({ error: { message: "overloaded" } })])).rejects.toThrow("overloaded");
  });

  it("skips chunks without choices (usage-only chunks)", async () => {
    const events = await parse([sse(chunk({ content: "a" }), chunk({}, "stop"), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }, "[DONE]")]);
    expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { input: 5, output: 2 } });
  });
});

describe("usage normalisation", () => {
  const cases: Array<[string, Parameters<typeof normalizeUsage>[0], { input: number; output: number; cacheRead: number }]> = [
    ["plain", { prompt_tokens: 100, completion_tokens: 20 }, { input: 100, output: 20, cacheRead: 0 }],
    ["openai cached tokens", { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } }, { input: 40, output: 20, cacheRead: 60 }],
    ["deepseek cache hit", { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 70 }, { input: 30, output: 20, cacheRead: 70 }],
    ["everything cached", { prompt_tokens: 50, completion_tokens: 1, prompt_cache_hit_tokens: 50 }, { input: 0, output: 1, cacheRead: 50 }],
    ["missing fields", {}, { input: 0, output: 0, cacheRead: 0 }],
    ["cache bigger than prompt", { prompt_tokens: 5, completion_tokens: 0, prompt_cache_hit_tokens: 9 }, { input: 0, output: 0, cacheRead: 9 }],
  ];
  for (const [name, raw, expected] of cases) {
    it(`handles ${name}`, () => {
      expect(normalizeUsage(raw)).toMatchObject(expected);
    });
  }
});

describe("stream: tool calls", () => {
  const argsText = (value: unknown) => JSON.stringify(value);

  for (const seed of Array.from({ length: 40 }, (_, index) => index + 1)) {
    it(`assembles tool calls from fragments (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const count = rng.int(1, 4);
      const calls = Array.from({ length: count }, (_, index) => ({ id: `call_${index}`, name: `tool${index}`, args: { n: rng.int(0, 999), s: "x".repeat(rng.int(0, 30)) } }));
      const chunks: unknown[] = [];
      for (const [index, call] of calls.entries()) {
        const text = argsText(call.args);
        const cut = rng.int(0, text.length);
        chunks.push(chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: text.slice(0, cut) } }] }));
        chunks.push(chunk({ tool_calls: [{ index, function: { arguments: text.slice(cut) } }] }));
      }
      chunks.push(chunk({}, "tool_calls"), "[DONE]");
      const events = await parse([sse(...chunks)]);
      const got = events.filter((event) => event.type === "tool_call").map((event) => (event as { call: unknown }).call);
      expect(got).toEqual(calls);
      expect(events.at(-1)).toEqual({ type: "done", stop: "tool_use" });
    });
  }

  it("interleaved fragments of two calls are kept apart by index", async () => {
    const events = await parse([
      sse(
        chunk({
          tool_calls: [
            { index: 0, id: "a", function: { name: "one", arguments: '{"x"' } },
            { index: 1, id: "b", function: { name: "two", arguments: '{"y"' } },
          ],
        }),
        chunk({
          tool_calls: [
            { index: 1, function: { arguments: ":2}" } },
            { index: 0, function: { arguments: ":1}" } },
          ],
        }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ),
    ]);
    expect(events.filter((event) => event.type === "tool_call").map((event) => (event as { call: unknown }).call)).toEqual([
      { id: "a", name: "one", args: { x: 1 } },
      { id: "b", name: "two", args: { y: 2 } },
    ]);
  });

  it("gives a call without an id a stable generated id", async () => {
    const events = await parse([sse(chunk({ tool_calls: [{ index: 0, function: { name: "t", arguments: "{}" } }] }), chunk({}, "tool_calls"), "[DONE]")]);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ call: { id: "call_1" } });
  });

  it("treats empty arguments as an empty object", async () => {
    const events = await parse([sse(chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "t", arguments: "" } }] }), chunk({}, "tool_calls"), "[DONE]")]);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ call: { args: {} } });
  });

  it("passes unparsable arguments on as raw text when the reply ended normally", async () => {
    const events = await parse([sse(chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "t", arguments: "{bad" } }] }), chunk({}, "tool_calls"), "[DONE]")]);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ call: { args: "{bad" } });
  });

  for (const variant of [1, 2, 3, 4, 5]) {
    it(`reports a call cut off by the length limit as truncated (variant ${variant})`, async () => {
      const events = await parse([
        sse(
          chunk({
            tool_calls: [
              { index: 0, id: "ok", function: { name: "done", arguments: "{}" } },
              { index: 1, id: "cut", function: { name: "write", arguments: `{"content":"abc${variant}` } },
            ],
          }),
          chunk({}, "length"),
          "[DONE]",
        ),
      ]);
      expect(events.some((event) => event.type === "tool_call_truncated" && event.id === "cut")).toBe(true);
      expect(events.some((event) => event.type === "tool_call" && event.call.id === "ok")).toBe(true);
      expect(events.at(-1)).toEqual({ type: "done", stop: "length" });
    });
  }
});
