import type { LlmClient, LlmEvent, LlmRequest, ProviderError, StopReason, Usage } from "@sakura/kernel";

export interface FauxTurn {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: unknown; id?: string }>;
  /** Cut the output off in the middle of this tool call (finish_reason "length"). */
  truncatedToolCall?: { name: string; id?: string };
  usage?: Partial<Usage>;
  stop?: StopReason;
  /** Fail the request instead of answering. */
  error?: ProviderError;
  /** Never answer; wait until the request is aborted. */
  hang?: boolean;
  /** Send this text, then a restart (as an adapter does after a dropped connection), then the real reply. */
  droppedFirst?: string;
  /** Split text into pieces of this many characters (default: one piece). */
  chunkSize?: number;
}

export type FauxScript = FauxTurn[] | ((request: LlmRequest, index: number) => FauxTurn);

export interface FauxClient extends LlmClient {
  /** Every request received, in order. */
  requests: LlmRequest[];
}

export interface FauxOptions {
  contextWindow?: number;
  supportsImages?: boolean;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function* pieces(value: string, size: number | undefined): Generator<string> {
  if (!size || size >= value.length) {
    yield value;
    return;
  }
  for (let start = 0; start < value.length; start += size) yield value.slice(start, start + size);
}

/** A scripted stand-in for a model: replays the given turns, one per request. */
export function createFauxClient(script: FauxScript, options: FauxOptions = {}): FauxClient {
  const requests: LlmRequest[] = [];
  let callCount = 0;
  return {
    requests,
    model: { id: "faux", contextWindow: options.contextWindow ?? 100_000, supportsImages: options.supportsImages ?? true },
    async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmEvent> {
      requests.push(request);
      const index = callCount++;
      const turn = typeof script === "function" ? script(request, index) : script[index];
      if (!turn) throw new Error(`faux script has no turn for request ${index + 1}`);
      if (signal.aborted) throw abortError();
      if (turn.error) throw turn.error;
      if (turn.hang) await waitForAbort(signal);

      if (turn.droppedFirst) {
        yield { type: "text_delta", delta: turn.droppedFirst };
        yield { type: "restart" };
      }
      if (turn.reasoning) yield { type: "reasoning_delta", delta: turn.reasoning };
      if (turn.text) for (const piece of pieces(turn.text, turn.chunkSize)) yield { type: "text_delta", delta: piece };
      let toolCount = 0;
      for (const call of turn.toolCalls ?? []) {
        toolCount++;
        yield { type: "tool_call", call: { id: call.id ?? `call_${index + 1}_${toolCount}`, name: call.name, args: call.args } };
      }
      if (turn.truncatedToolCall) {
        yield { type: "tool_call_truncated", id: turn.truncatedToolCall.id ?? `call_${index + 1}_cut`, name: turn.truncatedToolCall.name };
      }
      const output = estimateTokens([turn.text, turn.reasoning, turn.toolCalls]);
      yield {
        type: "usage",
        usage: { input: estimateTokens(request.messages), output, cacheRead: 0, cacheWrite: 0, ...turn.usage },
      };
      const stop: StopReason = turn.stop ?? (turn.truncatedToolCall ? "length" : toolCount > 0 ? "tool_use" : "stop");
      yield { type: "done", stop };
    },
  };
}
