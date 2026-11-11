// How full the context is right now, for the status line.
//
// The framework counts the context from the last reply that carries provider-reported usage. After a compaction the kept
// messages still carry the usage from before it, so that count stays too high until the next reply arrives. This file
// detects that case from the log and estimates the compacted context instead (four characters per token, like the framework).
import type { ContextStatus, LogEntry, Message } from "./framework.ts";

/** The part of an agent the measurement needs. */
export interface ContextSource {
  context(): Promise<ContextStatus>;
  log: { branch(): Promise<readonly LogEntry[]> };
}

export interface ContextMeasure {
  /** Tokens in the context now. */
  tokens: number;
  /** The model's window. */
  window: number;
  /** True when the number is an estimate (a compaction happened and no reply has reported usage since). */
  estimated: boolean;
}

function messageCharacters(message: Message): number {
  let characters = 0;
  for (const part of message.content) {
    if (part.type === "text") characters += part.text.length;
    else if (part.type === "tool_call") characters += part.name.length + JSON.stringify(part.args ?? "").length;
    else if (part.type === "image") characters += 4000;
    else characters += JSON.stringify((part as { data?: unknown }).data ?? "").length;
  }
  return characters;
}

/** Tokens of the log from the compaction on: the summary, the kept messages and everything after. */
export function estimateAfterCompaction(branch: readonly LogEntry[]): number | undefined {
  const compaction = branch.findLastIndex((entry) => entry.type === "compaction");
  const entry = branch[compaction];
  if (!entry || entry.type !== "compaction") return undefined;
  const kept = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
  const from = kept === -1 ? compaction + 1 : kept;
  let characters = entry.summary.length;
  for (let index = from; index < branch.length; index++) {
    const candidate = branch[index];
    if (candidate?.type === "message") characters += messageCharacters(candidate.message);
    else if (candidate?.type === "custom_message") characters += candidate.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  }
  return Math.ceil(characters / 4);
}

export async function measureContext(source: ContextSource): Promise<ContextMeasure> {
  const status = await source.context();
  const branch = await source.log.branch();
  const compaction = branch.findLastIndex((entry) => entry.type === "compaction");
  if (compaction === -1) return { tokens: status.tokens, window: status.window, estimated: false };
  const replied = branch.slice(compaction + 1).some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.usage !== undefined);
  if (replied) return { tokens: status.tokens, window: status.window, estimated: false };
  const tokens = estimateAfterCompaction(branch) ?? status.tokens;
  return { tokens, window: status.window, estimated: true };
}
