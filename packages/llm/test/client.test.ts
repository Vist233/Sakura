import { describe, expect, it } from "vitest";
import type { LlmRequest } from "@sakura/kernel";
import { compatPresets, createChatClient } from "../src/index.ts";
import { chunk, collect, sse, streamResponse } from "./helpers.ts";

const request: LlmRequest = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], ts: 1 }], tools: [] };
const goodStream = () => streamResponse([sse(chunk({ content: "hello" }), chunk({}, "stop", { usage: { prompt_tokens: 3, completion_tokens: 1 } }), "[DONE]")]);

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createChatClient({
    baseUrl: "https://example.test/v1/",
    apiKey: "secret-key",
    model: "demo",
    contextWindow: 1000,
    fetch: fetchImpl,
    retry: { sleep: async () => undefined, random: () => 0 },
    ...extra,
  });
}

describe("chat client", () => {
  it("posts to /chat/completions with bearer auth and the translated body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return goodStream();
    };
    const events = await collect(client(fake, { headers: { "x-extra": "1" } }).stream(request, new AbortController().signal));
    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect((calls[0]!.init.headers as Record<string, string>)["x-extra"]).toBe("1");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: "demo", stream: true });
    expect(events.map((event) => event.type)).toEqual(["text_delta", "usage", "done"]);
  });

  it("exposes model info", () => {
    const info = client(async () => goodStream(), { compat: { ...compatPresets.deepseek, images: false } }).model;
    expect(info).toEqual({ id: "demo", contextWindow: 1000, supportsImages: false });
    expect(client(async () => goodStream(), { compat: compatPresets.deepseek }).model.supportsImages).toBe(true);
  });

  for (const [status, kind, retried] of [
    [401, "auth", false],
    [402, "quota", false],
    [429, "rate_limit", true],
    [500, "overloaded", true],
    [400, "invalid_request", false],
  ] as const) {
    it(`HTTP ${status} becomes a ${kind} error${retried ? " and is retried" : ""}`, async () => {
      let calls = 0;
      const fake: typeof fetch = async () => {
        calls++;
        return calls === 1 || !retried ? new Response("failure", { status }) : goodStream();
      };
      const run = collect(client(fake).stream(request, new AbortController().signal));
      if (retried) {
        await expect(run).resolves.toHaveLength(3);
        expect(calls).toBe(2);
      } else {
        await expect(run).rejects.toMatchObject({ kind });
        expect(calls).toBe(1);
      }
    });
  }

  it("turns a network failure into a retried network error", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      if (++calls < 3) throw new TypeError("fetch failed");
      return goodStream();
    };
    await collect(client(fake).stream(request, new AbortController().signal));
    expect(calls).toBe(3);
  });

  it("passes an abort through as an abort", async () => {
    const fake: typeof fetch = async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };
    await expect(collect(client(fake).stream(request, new AbortController().signal))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails clearly when the response has no body", async () => {
    const fake: typeof fetch = async () => new Response(null, { status: 200 });
    await expect(collect(client(fake, { retry: { maxRetries: 0, sleep: async () => undefined } }).stream(request, new AbortController().signal))).rejects.toMatchObject({ kind: "network" });
  });

  it("does not put the api key anywhere except the authorization header", async () => {
    let body = "";
    const fake: typeof fetch = async (_url, init) => {
      body = String((init as RequestInit).body);
      return goodStream();
    };
    await collect(client(fake).stream(request, new AbortController().signal));
    expect(body).not.toContain("secret-key");
  });
});
