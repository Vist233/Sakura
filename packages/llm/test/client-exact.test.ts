// Exact-behaviour tests for the chat client (see compaction-exact.test.ts for why they exist).
import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import type { LlmRequest } from "@sakura/kernel";
import { compatPresets, createChatClient } from "../src/index.ts";
import { chunk, collect, sse, streamResponse } from "./helpers.ts";

const request: LlmRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
const good = () => streamResponse([sse(chunk({ content: "ok" }), chunk({}, "stop"), "[DONE]")]);
const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  createChatClient({
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    model: "m",
    contextWindow: 1000,
    fetch: fetchImpl,
    retry: { sleep: async () => undefined, random: () => 0, maxRetries: 0, maxStallRetries: 0 },
    ...extra,
  });
const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("presets", () => {
  it("deepseek, moonshot and openai presets have exactly the known differences", () => {
    expect(compatPresets.deepseek).toEqual({ vendor: "deepseek", maxTokensField: "max_tokens", thinkingFormat: "deepseek", replayReasoning: true });
    expect(compatPresets.moonshot).toEqual({ vendor: "moonshot", maxTokensField: "max_tokens", images: true });
    expect(compatPresets.openai).toEqual({ vendor: "openai", maxTokensField: "max_completion_tokens", thinkingFormat: "openai" });
  });
});

describe("the request that is sent", () => {
  for (const [base, expected] of [
    ["https://a.test/v1", "https://a.test/v1/chat/completions"],
    ["https://a.test/v1/", "https://a.test/v1/chat/completions"],
    ["https://a.test/v1///", "https://a.test/v1/chat/completions"],
    ["https://a.test", "https://a.test/chat/completions"],
  ] as const) {
    it(`${base} -> ${expected}`, async () => {
      let url = "";
      await collect(
        client(
          async (input) => {
            url = String(input);
            return good();
          },
          { baseUrl: base },
        ).stream(request, new AbortController().signal),
      );
      expect(url).toBe(expected);
    });
  }

  it("sends JSON with a content type, the bearer key, and extra headers that can override", async () => {
    let init: RequestInit | undefined;
    await collect(
      client(
        async (_url, i) => {
          init = i;
          return good();
        },
        { headers: { "x-a": "1", "content-type": "application/custom" } },
      ).stream(request, new AbortController().signal),
    );
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(headers["x-a"]).toBe("1");
    expect(headers["content-type"]).toBe("application/custom");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body)).model).toBe("m");
  });

  it("the default image resolver reads the file and makes a data URL", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "img-"));
    await writeFile(join(dir, "a.png"), Buffer.from([1, 2, 3]));
    let body = "";
    const withImage: LlmRequest = { ...request, messages: [{ role: "user", ts: 1, content: [{ type: "image", mediaType: "image/png", ref: join(dir, "a.png") }] }] };
    await collect(
      client(
        async (_u, i) => {
          body = String(i!.body);
          return good();
        },
        { compat: { images: true } },
      ).stream(withImage, new AbortController().signal),
    );
    await rm(dir, { recursive: true, force: true });
    expect(body).toContain("data:image/png;base64,AQID");
  });
});

describe("failures are turned into provider errors", () => {
  it("a rejected fetch is a network error that keeps the message", async () => {
    const error = await failure(
      collect(
        client(async () => {
          throw new Error("connection refused");
        }).stream(request, new AbortController().signal),
      ),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "network", message: "connection refused" });
  });
  it("a rejection that is not an Error gets a generic message", async () => {
    const error = await failure(
      collect(
        client(async () => {
          throw "weird";
        }).stream(request, new AbortController().signal),
      ),
    );
    expect(error).toMatchObject({ kind: "network", message: "network error" });
  });
  it("an HTTP error status is classified from the status and body", async () => {
    const error = await failure(collect(client(async () => new Response("slow down", { status: 429 })).stream(request, new AbortController().signal)));
    expect(error).toMatchObject({ kind: "rate_limit" });
    const auth = await failure(collect(client(async () => new Response("bad key", { status: 401 })).stream(request, new AbortController().signal)));
    expect(auth).toMatchObject({ kind: "auth" });
  });
  it("a response without a body is a network error", async () => {
    const error = await failure(collect(client(async () => new Response(null, { status: 200 })).stream(request, new AbortController().signal)));
    expect(error).toMatchObject({ kind: "network", message: "the provider returned no body" });
  });
  it("an error while reading the stream is a network error that keeps the message", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    const error = await failure(collect(client(async () => new Response(broken, { status: 200 })).stream(request, new AbortController().signal)));
    expect(error).toMatchObject({ kind: "network", message: "socket reset" });
  });
});

describe("timeouts and cancelling", () => {
  it("no response headers within the limit is a stalled-stream error (and the request is aborted)", async () => {
    let aborted = false;
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const error = await failure(collect(client(hang, { headerTimeoutMs: 50 }).stream(request, new AbortController().signal)));
    expect(error).toMatchObject({ kind: "network" });
    expect(String((error as Error).message)).toContain("stalled");
    expect(aborted).toBe(true);
  });

  it("a stream that goes quiet for longer than the idle limit is a stalled-stream error", async () => {
    const quiet = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(chunk({ content: "a" }))));
      },
    });
    const error = await failure(collect(client(async () => new Response(quiet, { status: 200 }), { idleTimeoutMs: 50 }).stream(request, new AbortController().signal)));
    expect(String((error as Error).message)).toContain("stalled");
  });

  it("aborting the caller's signal aborts the request and surfaces an AbortError, not a network error", async () => {
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init!.signal!;
        init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const pending = failure(collect(client(hang).stream(request, caller.signal)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    caller.abort();
    const error = await pending;
    expect((error as Error).name).toBe("AbortError");
    expect(seen!.aborted).toBe(true);
  });

  it("a signal that is already aborted never reaches the network as a live request", async () => {
    const caller = new AbortController();
    caller.abort();
    let signalAtFetch: boolean | undefined;
    const error = await failure(
      collect(
        client(async (_u, init) => {
          signalAtFetch = init!.signal!.aborted;
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }).stream(request, caller.signal),
      ),
    );
    expect(signalAtFetch).toBe(true);
    expect((error as Error).name).toBe("AbortError");
  });

  it("after a normal finish the request's own signal is released (aborted) so nothing stays open", async () => {
    let seen: AbortSignal | undefined;
    await collect(
      client(async (_u, init) => {
        seen = init!.signal!;
        return good();
      }).stream(request, new AbortController().signal),
    );
    expect(seen!.aborted).toBe(true);
  });
});
