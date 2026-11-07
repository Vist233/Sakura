import { readFile } from "node:fs/promises";
import { ProviderError } from "@sakura/kernel";
import type { LlmClient, LlmEvent, LlmRequest } from "@sakura/kernel";
import { defaultCompat } from "./chat/compat.ts";
import type { ChatCompat } from "./chat/compat.ts";
import { classifyHttpError, StalledStreamError } from "./chat/errors.ts";
import { toWireRequest } from "./chat/request.ts";
import type { ResolveImage } from "./chat/request.ts";
import { defaultRetry, withRetry } from "./chat/retry.ts";
import type { RetryPolicy } from "./chat/retry.ts";
import { parseChatStream } from "./chat/stream.ts";

export type { ChatCompat } from "./chat/compat.ts";
export type { RetryPolicy } from "./chat/retry.ts";

export interface ChatClientOptions {
  /** Base URL without the trailing /chat/completions, for example https://api.deepseek.com */
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  compat?: Partial<ChatCompat>;
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
  /** A reply that sends nothing for this long (default 60000 ms) counts as stalled and is tried again once. */
  idleTimeoutMs?: number;
  /** Waiting for the first response headers longer than this (default 120000 ms) counts as a stall too. */
  headerTimeoutMs?: number;
  /** For tests: replaces the global fetch. */
  fetch?: typeof fetch;
  /** Turns an image reference (a file path) into a URL the provider accepts. The default reads the file into a data URL. */
  resolveImage?: ResolveImage;
}

/** Passes the chunks of a stream through and fails with StalledStreamError if none arrives for `ms`. */
async function* watchIdle(source: AsyncIterable<Uint8Array>, ms: number, cancel: () => void): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const next = iterator.next();
      next.catch(() => undefined); // a read that fails after we gave up is not an error any more
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), ms);
      });
      const result = await Promise.race([next, stalled]);
      clearTimeout(timer);
      if (result === "stalled") {
        cancel();
        throw new StalledStreamError(Math.round(ms / 1000));
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    void iterator.return?.();
  }
}

const readImageAsDataUrl: ResolveImage = async (ref, mediaType) => `data:${mediaType};base64,${(await readFile(ref)).toString("base64")}`;

/** Presets for providers whose differences are known. */
export const compatPresets = {
  deepseek: { vendor: "deepseek", maxTokensField: "max_tokens", thinkingFormat: "deepseek", replayReasoning: true },
  moonshot: { vendor: "moonshot", maxTokensField: "max_tokens", images: true },
  openai: { vendor: "openai", maxTokensField: "max_completion_tokens", thinkingFormat: "openai" },
} satisfies Record<string, Partial<ChatCompat>>;

/** A client for any provider that speaks Chat Completions. Differences are data in `compat`. */
export function createChatClient(options: ChatClientOptions): LlmClient {
  const compat: ChatCompat = { ...defaultCompat, ...options.compat };
  const retry: RetryPolicy = { ...defaultRetry, ...options.retry };
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const resolveImage = options.resolveImage ?? readImageAsDataUrl;

  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const headerTimeoutMs = options.headerTimeoutMs ?? 120_000;

  async function* attempt(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    const body = await toWireRequest(request, { model: options.model, compat, resolveImage });
    // each try has its own abort, so a stalled connection can be cut without cancelling the whole request
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal.addEventListener("abort", forward, { once: true });
    if (signal.aborted) controller.abort();
    try {
      let response: Response;
      try {
        let headerTimer: NodeJS.Timeout | undefined;
        const noHeaders = new Promise<never>((_, reject) => {
          headerTimer = setTimeout(() => {
            reject(new StalledStreamError(Math.round(headerTimeoutMs / 1000))); // first, so the abort below cannot win the race and look like a cancel
            controller.abort();
          }, headerTimeoutMs);
        });
        noHeaders.catch(() => undefined);
        try {
          response = await Promise.race([
            doFetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}`, ...options.headers },
              body: JSON.stringify(body),
              signal: controller.signal,
            }),
            noHeaders,
          ]);
        } finally {
          clearTimeout(headerTimer);
        }
      } catch (error) {
        if (error instanceof StalledStreamError) throw error;
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ProviderError("network", error instanceof Error ? error.message : "network error");
      }
      if (!response.ok) throw classifyHttpError(response.status, await response.text().catch(() => ""), response.headers);
      if (!response.body) throw new ProviderError("network", "the provider returned no body");
      try {
        yield* parseChatStream(
          watchIdle(response.body as unknown as AsyncIterable<Uint8Array>, idleTimeoutMs, () => controller.abort()),
          compat,
        );
      } catch (error) {
        if (error instanceof StalledStreamError || error instanceof ProviderError) throw error;
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ProviderError("network", error instanceof Error ? error.message : "stream error");
      }
    } finally {
      signal.removeEventListener("abort", forward);
      controller.abort();
    }
  }

  return {
    model: { id: options.model, contextWindow: options.contextWindow, supportsImages: compat.images },
    stream: (request, signal) => withRetry(() => attempt(request, signal), retry, signal),
  };
}
