import { COMPACTION_PREFIX } from "@sakura/kernel";
import type { Content, LogEntry, Message } from "@sakura/kernel";

function entryToMessage(entry: LogEntry): Message | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") return { role: "user", content: entry.content, ts: entry.ts };
  return undefined;
}

/** Index of the entry the visible history starts at (after the latest compaction), and the summary text if any. */
function findStart(branch: readonly LogEntry[]): { start: number; summary: string | undefined; compactedAt: number } {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const kept = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
    return { start: kept === -1 ? index + 1 : kept, summary: entry.summary, compactedAt: index };
  }
  return { start: 0, summary: undefined, compactedAt: -1 };
}

/** Token usage describes the context as it was then; after a compaction it no longer applies. */
function withoutUsage(message: Message): Message {
  const { usage: _usage, ...rest } = message;
  return rest;
}

/** Replacement content per entry id, from context_edit entries. A null replacement removes the message. */
function collectEdits(branch: readonly LogEntry[]): Map<string, Content[] | null> {
  const edits = new Map<string, Content[] | null>();
  for (const entry of branch) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  }
  return edits;
}

/** Tool results are written as each tool finishes; providers need them in the order of the calls. */
function orderToolResults(messages: Message[]): Message[] {
  const ordered: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as Message;
    ordered.push(message);
    if (message.role !== "assistant") continue;
    const callIds = message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : []));
    if (callIds.length < 2) continue;
    let end = index + 1;
    while (messages[end]?.role === "tool") end++;
    const results = messages.slice(index + 1, end);
    const rank = (result: Message) => {
      const position = callIds.indexOf(result.toolCallId ?? "");
      return position === -1 ? callIds.length : position;
    };
    ordered.push(...results.sort((a, b) => rank(a) - rank(b)));
    index = end - 1;
  }
  return ordered;
}

export function projectMessages(branch: readonly LogEntry[]): Message[] {
  const { start, summary, compactedAt } = findStart(branch);
  const edits = collectEdits(branch);
  const messages: Message[] = [];

  // Pinned entries (project instructions) stay in front even after compaction.
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry?.type !== "custom_message" || !entry.pinned) continue;
    const message = entryToMessage(entry);
    if (message) messages.push(message);
  }
  if (summary !== undefined) {
    messages.push({ role: "user", content: [{ type: "text", text: `${COMPACTION_PREFIX}\n\n${summary}` }], ts: 0 });
  }
  for (let index = start; index < branch.length; index++) {
    const entry = branch[index];
    if (!entry || (entry.type === "custom_message" && entry.pinned)) continue;
    const message = entryToMessage(entry);
    if (!message) continue;
    const edit = edits.get(entry.id);
    if (edit === null) continue;
    const current = index < compactedAt ? withoutUsage(message) : message;
    messages.push(edit === undefined ? current : { ...current, content: edit });
  }
  return orderToolResults(messages);
}
