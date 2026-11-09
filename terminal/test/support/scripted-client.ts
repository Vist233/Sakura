// A hand-written scripted model for tests, so tests depend only on the public LlmClient interface.
import type { LlmClient, LlmEvent, LlmRequest, StopReason, Usage } from "../../src/framework.ts";

export interface ScriptedTurn {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: unknown; id?: string }>;
  usage?: Partial<Usage>;
  /** Wait for the abort signal instead of answering. */
  hang?: boolean;
  /** Wait this long (ms) before answering, abortable. */
  delayMs?: number;
}

export interface ScriptedClient extends LlmClient {
  requests: LlmRequest[];
}

export type Script = ScriptedTurn[] | ((request: LlmRequest, index: number) => ScriptedTurn);

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function wait(ms: number | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = ms === undefined ? undefined : setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

export function scriptedClient(script: Script, contextWindow = 100_000): ScriptedClient {
  const requests: LlmRequest[] = [];
  let count = 0;
  return {
    requests,
    model: { id: "scripted", contextWindow, supportsImages: false },
    async *stream(request, signal): AsyncGenerator<LlmEvent> {
      requests.push(request);
      const index = count++;
      const turn = typeof script === "function" ? script(request, index) : script[index];
      if (!turn) throw new Error(`script has no turn for request ${index + 1}`);
      if (turn.hang) await wait(undefined, signal);
      if (turn.delayMs) await wait(turn.delayMs, signal);
      if (signal.aborted) throw abortError();
      if (turn.reasoning) yield { type: "reasoning_delta", delta: turn.reasoning };
      if (turn.text) for (const piece of turn.text.match(/[\s\S]{1,7}/g) ?? []) yield { type: "text_delta", delta: piece };
      let calls = 0;
      for (const call of turn.toolCalls ?? []) {
        calls += 1;
        yield { type: "tool_call", call: { id: call.id ?? `call_${index}_${calls}`, name: call.name, args: call.args } };
      }
      const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, ...turn.usage };
      yield { type: "usage", usage };
      const stop: StopReason = calls > 0 ? "tool_use" : "stop";
      yield { type: "done", stop };
    },
  };
}
