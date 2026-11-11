import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmEvent, LlmRequest } from "@sakura/kernel";
import { createChatClient } from "../src/index.ts";
import { parseChatStream } from "../src/chat/stream.ts";
import { defaultCompat } from "../src/chat/compat.ts";
import { bytesStream, chunk, collect, sse } from "./helpers.ts";

// A real failure (2026-11-11, an overnight run): the provider answered HTTP 200, streamed for 42 seconds, then sent an error frame inside the
// stream: "Streaming response failed: [500] EngineCore encountered an issue. See stack trace (above) for the root cause." The frame was classified
// "other", which is never retried, so the run ended after one attempt. These cases pin what should happen: a server-side failure inside the stream
// is as transient as the same failure in an HTTP status, and a reply that was cut off is sent again.

const ENGINE_DEAD = "Streaming response failed: [500] EngineCore encountered an issue. See stack trace (above) for the root cause.";
const request: LlmRequest = { system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
const compat = { ...defaultCompat, vendor: "test" };
const kindOf = async (frame: unknown) => {
  try {
    await collect(parseChatStream(bytesStream([sse(frame)]), compat));
  } catch (error) {
    return (error as { kind?: string }).kind;
  }
  return "no error";
};

describe("an error frame inside a stream is classified like the same error as an HTTP status", () => {
  const table: Array<[string, unknown, string]> = [
    ["the frame seen in production (message only)", { error: { message: ENGINE_DEAD } }, "overloaded"],
    ["a 5xx code on the frame", { error: { message: "engine failed", code: 500 } }, "overloaded"],
    ["a 503 code given as a string", { error: { message: "unavailable", code: "503" } }, "overloaded"],
    ["a rate limit", { error: { message: "slow down", code: 429 } }, "rate_limit"],
    ["a bracketed 429 in the text", { error: { message: "Streaming response failed: [429] too many requests" } }, "rate_limit"],
    ["a bad key", { error: { message: "invalid api key", code: 401 } }, "auth"],
    ["an error nobody can classify", { error: { message: "something odd" } }, "other"],
  ];
  for (const [name, frame, expected] of table) {
    it(`${name} is ${expected}`, async () => {
      expect(await kindOf(frame)).toBe(expected);
    });
  }
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections?.(), server.close();
});

/** A real local server: status 200 and a few words, then the error frame, for the first `failures` attempts; a whole reply afterwards. */
async function serve(failures: number): Promise<{ url: string; attempts: () => number }> {
  let attempts = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (attempts++ < failures) {
        res.write(sse(chunk({ content: "par" }), { error: { message: ENGINE_DEAD } }));
        res.end();
      } else {
        res.write(sse(chunk({ content: "whole reply" }), chunk({}, "stop"), "[DONE]"));
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, attempts: () => attempts };
}

const client = (url: string, maxRetries = 10) => createChatClient({ baseUrl: url, apiKey: "k", model: "m", contextWindow: 1000, retry: { sleep: async () => undefined, random: () => 0, maxRetries } });
const textOf = (events: LlmEvent[]) => {
  let text = "";
  for (const event of events) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "restart") text = "";
  }
  return text;
};

describe("an engine failure inside a 200 stream (real sockets)", () => {
  for (const failures of [1, 2, 4]) {
    it(`is tried again: ${failures} failed attempt(s), then a whole reply`, async () => {
      const { url, attempts } = await serve(failures);
      const events = await collect(client(url).stream(request, new AbortController().signal));
      expect(textOf(events)).toBe("whole reply");
      expect(attempts()).toBe(failures + 1);
    });
  }

  it("reports every retry through onRetry with the attempt number, the delay and the provider's text", async () => {
    const { url } = await serve(2);
    const seen: Array<{ attempt: number; delayMs: number; kind: string; message: string }> = [];
    const retrying = createChatClient({
      baseUrl: url,
      apiKey: "k",
      model: "m",
      contextWindow: 1000,
      retry: { sleep: async () => undefined, random: () => 0, onRetry: ({ attempt, delayMs, error }) => seen.push({ attempt, delayMs, kind: error.kind, message: error.message }) },
    });
    await collect(retrying.stream(request, new AbortController().signal));
    expect(seen.map((entry) => [entry.attempt, entry.delayMs, entry.kind])).toEqual([
      [1, 500, "overloaded"],
      [2, 1000, "overloaded"],
    ]);
    expect(seen[0]?.message).toContain("EngineCore");
  });

  it("gives the error back after the retries are used up, and says how often it tried", async () => {
    const { url, attempts } = await serve(100);
    await expect(collect(client(url, 3).stream(request, new AbortController().signal))).rejects.toThrow("EngineCore");
    expect(attempts()).toBe(4);
  });
});
