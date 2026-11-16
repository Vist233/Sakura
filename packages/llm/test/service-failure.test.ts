import { describe, expect, it } from "vitest";
import type { LlmRequest } from "@sakura/kernel";
import { createChatClient } from "../src/index.ts";
import { isRetryable, nonStreamError, transportError } from "../src/chat/errors.ts";
import { chunk, collect, sse, streamResponse } from "./helpers.ts";

const request: LlmRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
const goodStream = () => streamResponse([sse(chunk({ content: "hello" }), chunk({}, "stop"), "[DONE]")]);

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createChatClient({
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    model: "demo",
    contextWindow: 1000,
    fetch: fetchImpl,
    retry: { sleep: async () => undefined, random: () => 0 },
    ...extra,
  });
}

/** A body that never delivers anything and ends when the request is cut. */
function hangingBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    },
  });
}

describe("an error response whose body never arrives", () => {
  it("is classified by its status and retried, instead of hanging", async () => {
    let calls = 0;
    const fake: typeof fetch = async (_url, init) => (++calls === 1 ? new Response(hangingBody(init?.signal), { status: 503 }) : goodStream());
    const events = await collect(client(fake, { idleTimeoutMs: 20 }).stream(request, new AbortController().signal));
    expect(calls).toBe(2);
    expect(events.at(-1)).toEqual({ type: "done", stop: "stop" });
  });

  it("an auth error with a hanging body is still an auth error", async () => {
    const fake: typeof fetch = async (_url, init) => new Response(hangingBody(init?.signal), { status: 401 });
    await expect(collect(client(fake, { idleTimeoutMs: 20 }).stream(request, new AbortController().signal))).rejects.toMatchObject({ kind: "auth", status: 401 });
  });
});

describe("a 200 answer that is not a stream", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("a JSON error says what the provider said, and a server-side one is retried", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => (++calls === 1 ? json({ error: { message: "[503] upstream overloaded" } }) : goodStream());
    await collect(client(fake).stream(request, new AbortController().signal));
    expect(calls).toBe(2);
  });

  it("a JSON error that is the request's fault is not retried and keeps its text", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return json({ error: { message: "model not found", code: 404 } });
    };
    await expect(collect(client(fake).stream(request, new AbortController().signal))).rejects.toMatchObject({ kind: "invalid_request", message: "model not found" });
    expect(calls).toBe(1);
  });

  it("an HTML page from a proxy is reported and not retried", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    await expect(collect(client(fake).stream(request, new AbortController().signal))).rejects.toMatchObject({ kind: "other", message: expect.stringContaining("captive portal") });
    expect(calls).toBe(1);
  });

  it("nonStreamError handles a string error and an empty body", () => {
    expect(nonStreamError('{"error":"bad key"}').message).toBe("bad key");
    expect(nonStreamError("").message).toContain("(empty)");
  });
});

describe("a transport failure that cannot get better", () => {
  const cause = (code: string) => transportError(Object.assign(new Error("tls"), { code }), "response_headers", "x");

  it("a wrong certificate is not retried", () => {
    for (const code of ["CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"])
      expect(isRetryable(cause(code))).toBe(false);
  });

  it("a lost network, a refused connection and a reset still are", () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH"]) expect(isRetryable(cause(code))).toBe(true);
  });

  it("fails at once on a certificate error, with the first error and no waiting", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("expired"), { code: "CERT_HAS_EXPIRED" }) });
    };
    await expect(collect(client(fake).stream(request, new AbortController().signal))).rejects.toMatchObject({ kind: "network", transport: { code: "CERT_HAS_EXPIRED" } });
    expect(calls).toBe(1);
  });
});
