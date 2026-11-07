import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import type { LlmEvent } from "@sakura/kernel";
import { classifyHttpError } from "../src/chat/errors.ts";
import { backoffDelay, defaultRetry, withRetry } from "../src/chat/retry.ts";
import type { RetryPolicy } from "../src/chat/retry.ts";
import { collect } from "./helpers.ts";

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe("error classification", () => {
  const table: Array<[number, string, string]> = [
    [401, "invalid api key", "auth"],
    [403, "forbidden", "auth"],
    [402, "Insufficient Balance", "quota"],
    [429, "You exceeded your current quota", "quota"],
    [429, "insufficient credit", "quota"],
    [429, "slow down", "rate_limit"],
    [429, "", "rate_limit"],
    [400, "This model's maximum context length is 8192 tokens", "context_overflow"],
    [400, "prompt is too long: 250000 tokens", "context_overflow"],
    [400, "Input tokens exceed the context window", "context_overflow"],
    [413, "payload too large", "context_overflow"],
    [422, "context length exceeded", "context_overflow"],
    [500, "internal error", "overloaded"],
    [502, "bad gateway", "overloaded"],
    [503, "unavailable", "overloaded"],
    [529, "overloaded", "overloaded"],
    [408, "timeout", "overloaded"],
    [409, "conflict", "overloaded"],
    [400, "bad request", "invalid_request"],
    [404, "no such model", "invalid_request"],
    [422, "unprocessable", "invalid_request"],
    [400, "account balance is not enough, please recharge", "quota"],
  ];
  for (const [status, body, kind] of table) {
    it(`${status} "${body.slice(0, 40)}" is ${kind}`, () => {
      expect(classifyHttpError(status, body, headers()).kind).toBe(kind);
    });
  }

  for (const [name, init, expected] of [
    ["retry-after seconds", { "retry-after": "7" }, 7000],
    ["retry-after-ms", { "retry-after-ms": "250" }, 250],
    ["no header", {}, undefined],
    ["garbage header", { "retry-after": "soon" }, undefined],
  ] as Array<[string, Record<string, string>, number | undefined]>) {
    it(`reads ${name}`, () => {
      expect(classifyHttpError(429, "slow", headers(init)).retryAfterMs).toBe(expected);
    });
  }

  it("keeps the status and trims long bodies", () => {
    const error = classifyHttpError(500, "x".repeat(5000), headers());
    expect(error.status).toBe(500);
    expect(error.message.length).toBeLessThanOrEqual(500);
  });
});

function policy(overrides: Partial<RetryPolicy> = {}) {
  const sleeps: number[] = [];
  const value: RetryPolicy = { ...defaultRetry, sleep: async (ms) => void sleeps.push(ms), random: () => 0, ...overrides };
  return { value, sleeps };
}

function flaky(failures: ProviderError[], after: LlmEvent[]) {
  let calls = 0;
  return {
    attempt: async function* (): AsyncGenerator<LlmEvent> {
      const failure = failures[calls++];
      if (failure) throw failure;
      for (const event of after) yield event;
    },
    count: () => calls,
  };
}

const ok: LlmEvent[] = [
  { type: "text_delta", delta: "hi" },
  { type: "done", stop: "stop" },
];
const signal = () => new AbortController().signal;

describe("retry", () => {
  for (const kind of ["rate_limit", "overloaded", "network"] as const) {
    for (const failures of [1, 2, 5]) {
      it(`retries ${kind} ${failures} time(s) then succeeds`, async () => {
        const { value, sleeps } = policy();
        const source = flaky(
          Array.from({ length: failures }, () => new ProviderError(kind, "x")),
          ok,
        );
        const events = await collect(withRetry(source.attempt, value, signal()));
        expect(events).toEqual(ok);
        expect(source.count()).toBe(failures + 1);
        expect(sleeps).toHaveLength(failures);
      });
    }
  }

  for (const kind of ["quota", "auth", "context_overflow", "invalid_request", "other"] as const) {
    it(`does not retry ${kind}`, async () => {
      const { value } = policy();
      const source = flaky([new ProviderError(kind, "x")], ok);
      await expect(collect(withRetry(source.attempt, value, signal()))).rejects.toMatchObject({ kind });
      expect(source.count()).toBe(1);
    });
  }

  it("gives up after the maximum number of retries", async () => {
    const { value } = policy({ maxRetries: 3 });
    const source = flaky(
      Array.from({ length: 10 }, () => new ProviderError("overloaded", "busy")),
      ok,
    );
    await expect(collect(withRetry(source.attempt, value, signal()))).rejects.toMatchObject({ kind: "overloaded" });
    expect(source.count()).toBe(4);
  });

  it("backs off exponentially up to the cap", () => {
    const { value } = policy();
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => backoffDelay(value, index));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 32000, 32000]);
  });

  it("takes up to 25 percent off for jitter", () => {
    const { value } = policy({ random: () => 1 });
    expect(backoffDelay(value, 0)).toBe(375);
  });

  it("uses the server's retry-after instead of the backoff", async () => {
    const { value, sleeps } = policy();
    const source = flaky([new ProviderError("rate_limit", "x", 429, 1234)], ok);
    await collect(withRetry(source.attempt, value, signal()));
    expect(sleeps).toEqual([1234]);
  });

  it("does not wait for a server delay longer than the limit", async () => {
    const { value, sleeps } = policy({ maxServerDelayMs: 10_000 });
    const source = flaky([new ProviderError("rate_limit", "x", 429, 90_000)], ok);
    await expect(collect(withRetry(source.attempt, value, signal()))).rejects.toMatchObject({ kind: "rate_limit" });
    expect(sleeps).toEqual([]);
  });

  it("retries after partial text and tells the caller to throw the partial reply away", async () => {
    const { value } = policy();
    let calls = 0;
    async function* flaky2(): AsyncGenerator<LlmEvent> {
      if (++calls === 1) {
        yield { type: "text_delta", delta: "partial" };
        throw new ProviderError("network", "dropped");
      }
      yield { type: "text_delta", delta: "whole reply" };
      yield { type: "done", stop: "stop" };
    }
    const events = await collect(withRetry(flaky2, value, signal()));
    expect(events.map((event) => event.type)).toEqual(["text_delta", "restart", "text_delta", "done"]);
    expect(calls).toBe(2);
  });

  it("never retries once a complete tool call has been passed on", async () => {
    const { value } = policy();
    let calls = 0;
    async function* broken(): AsyncGenerator<LlmEvent> {
      calls++;
      yield { type: "tool_call", call: { id: "c", name: "bash", args: {} } };
      throw new ProviderError("network", "dropped");
    }
    await expect(collect(withRetry(broken, value, signal()))).rejects.toMatchObject({ kind: "network" });
    expect(calls).toBe(1);
  });

  it("reports each retry", async () => {
    const infos: number[] = [];
    const { value } = policy({ onRetry: (info) => infos.push(info.attempt) });
    await collect(withRetry(flaky([new ProviderError("overloaded", "a"), new ProviderError("overloaded", "b")], ok).attempt, value, signal()));
    expect(infos).toEqual([1, 2]);
  });

  it("stops waiting when aborted", async () => {
    const controller = new AbortController();
    const { value } = policy({ sleep: async () => controller.abort() });
    const source = flaky([new ProviderError("overloaded", "a"), new ProviderError("overloaded", "b")], ok);
    await expect(collect(withRetry(source.attempt, value, controller.signal))).rejects.toBeInstanceOf(ProviderError);
    expect(source.count()).toBe(2);
  });

  it("passes non-provider errors straight through", async () => {
    const { value } = policy();
    async function* boom(): AsyncGenerator<LlmEvent> {
      yield* [];
      throw new Error("bug");
    }
    await expect(collect(withRetry(boom, value, signal()))).rejects.toThrow("bug");
  });
});
