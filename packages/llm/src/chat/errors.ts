import { ProviderError } from "@sakura/kernel";

const OVERFLOW = /context.{0,20}(length|window)|maximum context|too many tokens|prompt is too long|exceeds the (context|model)|input.{0,20}too long|reduce the length/i;
const QUOTA = /insufficient|balance|quota|billing|credit|exceeded your current|out of (money|funds)|arrears|recharge/i;

function parseRetryAfter(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number.parseFloat(ms))) return Number.parseFloat(ms);
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Maps an HTTP error response to a ProviderError. */
export function classifyHttpError(status: number, bodyText: string, headers: Headers): ProviderError {
  const message = bodyText.trim().slice(0, 500) || `HTTP ${status}`;
  const retryAfter = parseRetryAfter(headers);
  if (status === 401 || status === 403) return new ProviderError("auth", message, status);
  if (status === 402 || (status === 429 && QUOTA.test(bodyText))) return new ProviderError("quota", message, status);
  if (OVERFLOW.test(bodyText) && (status === 400 || status === 413 || status === 422)) return new ProviderError("context_overflow", message, status);
  if (status === 413) return new ProviderError("context_overflow", message, status);
  if (status === 429) return new ProviderError("rate_limit", message, status, retryAfter);
  if (status === 408 || status === 409 || status === 529 || status >= 500) return new ProviderError("overloaded", message, status, retryAfter);
  if (QUOTA.test(bodyText) && status >= 400) return new ProviderError("quota", message, status);
  return new ProviderError("invalid_request", message, status);
}

const BRACKETED_STATUS = /\[(\d{3})\]/;
const SERVER_SIDE_TYPE = /server_error|overloaded|internal/i;

/**
 * An error sent inside a stream that already started (the HTTP status was 200). It is classified like the same error would be as an HTTP status:
 * the status comes from the frame's `code` or `status`, or from a bracketed number in the text ("[500] EngineCore ..."). Without a status, a type
 * that names a server-side failure counts as overloaded; anything else stays "other" and is not retried, because a request that is wrong would be wrong again.
 */
export function classifyStreamError(error: { message?: string; code?: unknown; status?: unknown; type?: unknown }): ProviderError {
  const message = error.message?.trim() || "the provider reported an error in the stream";
  const given = Number(error.code ?? error.status);
  const status = Number.isInteger(given) && given >= 400 && given < 600 ? given : Number(BRACKETED_STATUS.exec(message)?.[1]);
  if (status >= 400 && status < 600) return classifyHttpError(status, message, new Headers());
  if (typeof error.type === "string" && SERVER_SIDE_TYPE.test(error.type)) return new ProviderError("overloaded", message);
  return new ProviderError("other", message);
}

export const isRetryable = (error: ProviderError): boolean => error.kind === "rate_limit" || error.kind === "overloaded" || error.kind === "network";

/** The connection is open but nothing has arrived for too long. */
export class StalledStreamError extends ProviderError {
  constructor(seconds: number) {
    super("network", `the stream stalled: no data for ${seconds} seconds`);
    this.name = "StalledStreamError";
  }
}
