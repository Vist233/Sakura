import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRequest } from "@sakura/kernel";
import { createChatClient } from "../src/index.ts";
import { sse, chunk } from "./helpers.ts";

// A stream that is cancelled or fails must leave no timer behind: a timer that is still running keeps the whole process alive after the agent was closed.
const request: LlmRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
const encoder = new TextEncoder();

afterEach(() => vi.useRealTimers());

/** A provider that sends one chunk and then nothing, until the request is aborted or `breakIt` is called. */
function silentAfterFirstChunk() {
  let breakIt = () => {};
  const fake: typeof fetch = async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse(chunk({ content: "first " }))));
        const fail = (error: unknown) => controller.error(error);
        init?.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        breakIt = () => fail(new TypeError("terminated"));
      },
    });
    return new Response(body, { status: 200 });
  };
  return { fake, breakIt: () => breakIt() };
}

const client = (fake: typeof fetch) => createChatClient({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m", contextWindow: 1000, fetch: fake, retry: { maxRetries: 0 } });

async function readAll(iterable: AsyncIterable<unknown>) {
  const seen: unknown[] = [];
  try {
    for await (const event of iterable) seen.push(event);
  } catch (error) {
    return { seen, error };
  }
  return { seen, error: undefined };
}

describe("the stream leaves no timer behind", () => {
  it("when it is cancelled while waiting for the next chunk", async () => {
    vi.useFakeTimers();
    const { fake } = silentAfterFirstChunk();
    const controller = new AbortController();
    const reading = readAll(client(fake).stream(request, controller.signal));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const { error } = await reading;
    expect((error as Error).name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("when the connection breaks while waiting for the next chunk", async () => {
    vi.useFakeTimers();
    const { fake, breakIt } = silentAfterFirstChunk();
    const reading = readAll(client(fake).stream(request, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(100);
    breakIt();
    const { error } = await reading;
    expect(error).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
