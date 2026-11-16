import { readFile } from "node:fs/promises";
import { ProviderError, THINKING_LEVELS } from "@sakura/kernel";
import type { LlmClient, LlmEvent, LlmRequest } from "@sakura/kernel";
import { defaultCompat } from "./chat/compat.ts";
import type { ChatCompat } from "./chat/compat.ts";
import { classifyHttpError, nonStreamError, StalledStreamError, transportError } from "./chat/errors.ts";
import { imageDataUrl } from "./chat/image.ts";
import { imageRefs, isImageRejection, withoutImages } from "./chat/repair.ts";
import { toWireRequest } from "./chat/request.ts";
import type { ResolveImage } from "./chat/request.ts";
import { defaultRetry, withRetry } from "./chat/retry.ts";
import type { RetryPolicy } from "./chat/retry.ts";
import { parseChatStream } from "./chat/stream.ts";

export type { ChatCompat } from "./chat/compat.ts";
export { bmpToPng, imageDataUrl, SENDABLE_IMAGE_TYPES, sniffImageType } from "./chat/image.ts";
export type { ImageType } from "./chat/image.ts";
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

/** The text of a small response body, or "" when it fails or nothing arrives for `ms` (the connection is then cut): a body that hangs must not hold up the retry. */
async function readBodyWithin(response: Response, ms: number, cancel: () => void): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const text = response.text().catch(() => "");
  const stalled = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      cancel();
      resolve("");
    }, ms);
  });
  try {
    return await Promise.race([text, stalled]);
  } finally {
    clearTimeout(timer);
  }
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
      let result: Awaited<typeof next> | "stalled";
      try {
        result = await Promise.race([next, stalled]);
      } finally {
        clearTimeout(timer); // also when the read fails (a cancel, a broken connection): a timer left running keeps the process alive
      }
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

const readImageAsDataUrl: ResolveImage = async (ref) => imageDataUrl(await readFile(ref));

/** Presets for providers whose differences are known. */
const deepseekCompat = { vendor: "deepseek", maxTokensField: "max_tokens", thinkingFormat: "deepseek", replayReasoning: true } as const;
export const compatPresets = {
  deepseek: deepseekCompat,
  "commandcode-deepseek": { ...deepseekCompat, offEffort: "off", thinkingLevels: THINKING_LEVELS },
  /** DeepSeek Flash and Pro: Extra high and Max are offered; Extra high is sent as High, which is what the provider does with it. */
  "deepseek-flash": { ...deepseekCompat, thinkingLevels: THINKING_LEVELS, extraHighEffort: "high" },
  moonshot: { vendor: "moonshot", maxTokensField: "max_tokens", images: true },
  openai: { vendor: "openai", maxTokensField: "max_completion_tokens", thinkingFormat: "openai" },
} satisfies Record<string, Partial<ChatCompat>>;

/** Routes known to need another preset than the one a provider is set up with: the same family, a model and an endpoint with known differences. */
const compatRoutes: ReadonlyArray<{ preset: string; baseUrl: string; models: readonly string[]; use: keyof typeof compatPresets }> = [
  { preset: "deepseek", baseUrl: "https://api.commandcode.ai/provider/v1", models: ["deepseek/deepseek-v4.1-flash"], use: "commandcode-deepseek" },
  { preset: "deepseek", baseUrl: "https://api.deepseek.com", models: ["deepseek-flash", "deepseek-v4-pro"], use: "deepseek-flash" },
  { preset: "deepseek", baseUrl: "https://opencode.ai/zen/go/v1", models: ["deepseek-v4.1-flash"], use: "deepseek-flash" },
];

/** The compat settings for a provider set up with the named preset, serving this model at this address: a known route wins, else the preset itself. Undefined for an unknown name. */
export function resolveCompat(preset: string, baseUrl: string, model: string): Partial<ChatCompat> | undefined {
  const address = baseUrl.replace(/\/+$/, "");
  const route = compatRoutes.find((entry) => entry.preset === preset && entry.baseUrl === address && entry.models.includes(model));
  return (compatPresets as Record<string, Partial<ChatCompat>>)[route?.use ?? preset];
}

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
            reject(new StalledStreamError(Math.round(headerTimeoutMs / 1000), "response_headers")); // first, so the abort below cannot win the race and look like a cancel
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
        throw transportError(error, "response_headers", "network error");
      }
      if (!response.ok) throw classifyHttpError(response.status, await readBodyWithin(response, idleTimeoutMs, () => controller.abort()), response.headers);
      if (!response.body) throw transportError(undefined, "response_stream", "the provider returned no body");
      // Some gateways answer 200 with a plain JSON (or HTML) body instead of a stream, an error most often: say what it says instead of "the stream ended".
      if (/json|html/i.test(response.headers.get("content-type") ?? "")) throw nonStreamError(await readBodyWithin(response, idleTimeoutMs, () => controller.abort()));
      try {
        yield* parseChatStream(
          watchIdle(response.body as unknown as AsyncIterable<Uint8Array>, idleTimeoutMs, () => controller.abort()),
          compat,
        );
      } catch (error) {
        if (error instanceof StalledStreamError || error instanceof ProviderError) throw error;
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw transportError(error, "response_stream", "stream error");
      }
    } finally {
      signal.removeEventListener("abort", forward);
      controller.abort();
    }
  }

  // The images of a refused request are left out of this request and of every later one that has them; other images are still sent.
  const refusedImages = new Set<string>();
  async function* stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    const send = (wanted: LlmRequest) => withRetry(() => attempt(wanted, signal), retry, signal);
    const sendable = withoutImages(request, refusedImages);
    try {
      yield* send(sendable); // a refusal comes with the response status, before any event, so nothing has to be taken back
    } catch (error) {
      const refs = imageRefs(sendable);
      if (!isImageRejection(error) || refs.length === 0) throw error;
      for (const ref of refs) refusedImages.add(ref);
      yield* send(withoutImages(request, refusedImages));
    }
  }

  return {
    model: { id: options.model, contextWindow: options.contextWindow, supportsImages: compat.images },
    stream,
  };
}
