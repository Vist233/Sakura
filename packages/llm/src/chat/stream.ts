import { ProviderError } from "@sakura/kernel";
import type { LlmEvent, StopReason, ToolCall, Usage } from "@sakura/kernel";
import type { ChatCompat } from "./compat.ts";

interface ToolDraft {
  id: string;
  name: string;
  args: string;
}

interface ChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Input excludes cached tokens, so the four numbers add up to what was processed. */
export function normalizeUsage(raw: ChunkUsage): Usage {
  const cached = raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, (raw.prompt_tokens ?? 0) - cached), output: raw.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
}

/** Splits a byte stream into server-sent-event data payloads. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const last = buffer.replace(/\r$/, "");
  if (last.startsWith("data:")) yield last.slice(5).trimStart();
}

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

function stopFrom(finish: string | undefined, hasCalls: boolean): StopReason {
  if (finish === "length") return "length";
  if (finish === "tool_calls" || hasCalls) return "tool_use";
  return "stop";
}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** Turns Chat Completions stream chunks into model events. */
export async function* parseChatStream(body: AsyncIterable<Uint8Array>, compat: ChatCompat): AsyncGenerator<LlmEvent> {
  const drafts = new Map<number, ToolDraft>();
  let reasoning = "";
  let finish: string | undefined;
  let usage: Usage | undefined;
  let finished = false;

  for await (const data of sseData(body)) {
    if (data === "[DONE]") {
      finished = true;
      break;
    }
    let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: ChunkUsage | null; error?: { message?: string } };
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new ProviderError("network", "the provider sent a malformed stream chunk");
    }
    if (chunk.error) throw new ProviderError("other", chunk.error.message ?? "the provider reported an error in the stream");
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", delta: delta.content };
    for (const field of REASONING_FIELDS) {
      const value = delta[field];
      if (typeof value === "string" && value) {
        reasoning += value;
        yield { type: "reasoning_delta", delta: value };
        break;
      }
    }
    for (const piece of (delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined) ?? []) {
      const index = piece.index ?? 0;
      const draft = drafts.get(index) ?? { id: "", name: "", args: "" };
      if (piece.id) draft.id = piece.id;
      if (piece.function?.name) draft.name += piece.function.name;
      if (piece.function?.arguments) draft.args += piece.function.arguments;
      drafts.set(index, draft);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  if (!finished && finish === undefined) throw new ProviderError("network", "the stream ended before the reply was complete");

  if (reasoning) yield { type: "provider", vendor: compat.vendor, data: { reasoning } };
  const calls: ToolCall[] = [];
  let index = 0;
  for (const [, draft] of [...drafts.entries()].sort((a, b) => a[0] - b[0])) {
    index++;
    const id = draft.id || `call_${index}`;
    const parsed = parseArgs(draft.args);
    if (parsed.ok) {
      calls.push({ id, name: draft.name, args: parsed.value });
    } else if (finish === "length") {
      yield { type: "tool_call_truncated", id, name: draft.name };
    } else {
      calls.push({ id, name: draft.name, args: draft.args });
    }
  }
  for (const call of calls) yield { type: "tool_call", call };
  if (usage) yield { type: "usage", usage };
  yield { type: "done", stop: stopFrom(finish, calls.length > 0) };
}
