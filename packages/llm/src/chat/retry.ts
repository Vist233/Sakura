import { ProviderError } from "@sakura/kernel";
import type { LlmEvent } from "@sakura/kernel";
import { isRetryable, StalledStreamError } from "./errors.ts";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A server-requested wait longer than this is not honoured; the error is returned instead. */
  maxServerDelayMs: number;
  /** A stalled stream (silence for the idle timeout) is tried again this many times; each stall costs the idle timeout, so this bounds the waiting. */
  maxStallRetries: number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
  onRetry?(info: { attempt: number; delayMs: number; error: ProviderError }): void;
}

export const defaultRetry: RetryPolicy = {
  maxRetries: 10,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  maxServerDelayMs: 60_000,
  maxStallRetries: 4,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    }),
  random: Math.random,
};

export function backoffDelay(policy: RetryPolicy, retryIndex: number): number {
  const raw = Math.min(policy.baseDelayMs * 2 ** retryIndex, policy.maxDelayMs);
  return raw * (1 - policy.random() * 0.25);
}

/**
 * Runs one request, retrying transient failures. If the connection fails part-way through a reply, the request is
 * sent again and a `restart` event tells the caller to throw away what it has received so far. Once a complete tool
 * call has been passed on nothing is retried (running it twice could do harm); the error is returned instead.
 */
export async function* withRetry(attempt: () => AsyncIterable<LlmEvent>, policy: RetryPolicy, signal: AbortSignal): AsyncGenerator<LlmEvent> {
  let stalls = 0;
  for (let retry = 0; ; retry++) {
    let yielded = false;
    let committed = false; // a complete tool call (or the end of the reply) has been passed on
    try {
      for await (const event of attempt()) {
        yielded = true;
        if (event.type === "tool_call" || event.type === "tool_call_truncated" || event.type === "done") committed = true;
        yield event;
      }
      return;
    } catch (error) {
      if (committed || !(error instanceof ProviderError) || !isRetryable(error) || retry >= policy.maxRetries || signal.aborted) throw error;
      if (error instanceof StalledStreamError && ++stalls > policy.maxStallRetries) throw error;
      if (error.retryAfterMs !== undefined && error.retryAfterMs > policy.maxServerDelayMs) throw error;
      const delayMs = error.retryAfterMs ?? backoffDelay(policy, retry);
      policy.onRetry?.({ attempt: retry + 1, delayMs, error });
      await policy.sleep(delayMs, signal);
      if (yielded) yield { type: "restart" };
    }
  }
}
