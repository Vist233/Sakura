// How a finished run is reported to the client.
import type { RunResult } from "../framework.ts";
import { AcpError, ErrorCode } from "./types.ts";
import type { PromptResult } from "./types.ts";

export interface Outcome {
  result: PromptResult;
  /** Text to show the person as a message when the stop reason alone does not explain what happened. */
  notice?: string;
}

const PAUSE_NOTICES: Record<string, string> = {
  approval: "The run was paused because too many actions were refused by the review. Send a message to continue.",
  quota: "The run was paused: the provider's quota is used up.",
  budget: "The run was paused: its budget is used up.",
  input: "The run was paused and waits for input.",
  blocked: "The run was paused because the goal is blocked.",
};

/** Cuts a provider error to something a client may show: one short line, with anything that looks like a credential removed. */
export function safeErrorText(text: string): string {
  const cleaned = text
    .replace(/(authorization|x-api-key|api[-_]?key)\s*[:=]\s*(?:(?:bearer|basic)\s+)?\S+/gi, "$1: [removed]")
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [removed]")
    .replace(/\bsk-[\w-]{8,}/g, "[removed]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}…` : cleaned;
}

/**
 * `done` ends the turn; a cancel the client asked for is always `cancelled` (an abort that surfaces as an error is still a cancel);
 * a pause is a refusal with a note; a failed run is a JSON-RPC error.
 */
export function outcomeOf(result: RunResult, cancelRequested: boolean): Outcome {
  if (cancelRequested || result.reason === "cancelled") return { result: { stopReason: "cancelled" } };
  if (result.reason === "done") return { result: { stopReason: "end_turn" } };
  if (result.reason === "paused") return { result: { stopReason: "refusal" }, notice: PAUSE_NOTICES[result.pause ?? ""] ?? "The run was paused." };
  throw new AcpError(ErrorCode.internalError, `The run failed: ${safeErrorText(result.error ?? "unknown error")}`);
}
