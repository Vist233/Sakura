import { describe, expect, it } from "vitest";
import { backoffDelay, defaultRetry } from "../src/chat/retry.ts";

describe("default retry policy", () => {
  it("allows 10 retries and four retries of a stalled stream", () => {
    expect(defaultRetry.maxRetries).toBe(10);
    expect(defaultRetry.maxStallRetries).toBe(4);
  });

  it("sleep waits about the requested time", async () => {
    const started = Date.now();
    await defaultRetry.sleep(60, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("sleep stops at once when the signal is aborted, with an AbortError", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = defaultRetry.sleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("sleep with a signal that is already aborted fails without waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(defaultRetry.sleep(5000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("backoffDelay", () => {
  const policy = { ...defaultRetry, baseDelayMs: 500, maxDelayMs: 32_000, random: () => 0 };
  it("doubles each retry and stops at the maximum", () => {
    expect([0, 1, 2, 3, 6, 7, 20].map((retry) => backoffDelay(policy, retry))).toEqual([500, 1000, 2000, 4000, 32_000, 32_000, 32_000]);
  });
  it("jitter takes off up to a quarter", () => {
    expect(backoffDelay({ ...policy, random: () => 1 }, 0)).toBe(375);
    expect(backoffDelay({ ...policy, random: () => 0.5 }, 1)).toBe(875);
  });
});

describe("a stalled stream and the default policy", () => {
  const run = async (stalls: number) => {
    const { withRetry } = await import("../src/chat/retry.ts");
    const { StalledStreamError } = await import("../src/chat/errors.ts");
    let attempts = 0;
    const attempt = async function* () {
      attempts++;
      if (attempts <= stalls) throw new StalledStreamError(60);
      yield { type: "text_delta" as const, delta: "ok" };
      yield { type: "done" as const, stop: "stop" as const };
    };
    const policy = { ...defaultRetry, sleep: async () => undefined, random: () => 0 };
    const seen: string[] = [];
    try {
      for await (const event of withRetry(attempt, policy, new AbortController().signal)) seen.push(event.type);
      return { seen, error: undefined, attempts };
    } catch (error) {
      return { seen, error: error as Error, attempts };
    }
  };

  it("survives four stalls in a row (the run of a reasoning model is not lost to a bad minute)", async () => {
    const result = await run(4);
    expect(result.error).toBeUndefined();
    expect(result.seen).toContain("done");
    expect(result.attempts).toBe(5);
  });

  it("gives up on the fifth stall, so waiting is bounded", async () => {
    const result = await run(5);
    expect(result.error?.name).toBe("StalledStreamError");
    expect(result.attempts).toBe(5);
  });
});
