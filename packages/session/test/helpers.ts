import type { Content, LogEntry, Message } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import type { Rng } from "@sakura/testing";

export function text(value: string): Content[] {
  return [{ type: "text", text: value }];
}

export function textOf(message: Message): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function entry(id: string, parentId: string | null, body: Record<string, unknown>): LogEntry {
  return { id, parentId, ts: 1000, ...body } as LogEntry;
}

export function messageEntry(id: string, parentId: string | null, role: Message["role"], value: string): LogEntry {
  return entry(id, parentId, { type: "message", message: { role, content: text(value), ts: 1000 } });
}

export interface Built {
  entries: LogEntry[];
  /** Text of each message entry, in order, keyed by entry id. */
  texts: Map<string, string>;
  ids: string[];
}

/** A random alternating conversation of `count` message entries with ids e1..eN. */
export function buildConversation(seed: number, count: number): Built {
  const rng: Rng = createRng(seed);
  const entries: LogEntry[] = [];
  const texts = new Map<string, string>();
  const ids: string[] = [];
  let parent: string | null = null;
  for (let index = 1; index <= count; index++) {
    const id = `e${index}`;
    const role = index % 2 === 1 ? "user" : "assistant";
    const value = `${role} ${rng.int(0, 99999)} #${index}`;
    entries.push(messageEntry(id, parent, role, value));
    texts.set(id, value);
    ids.push(id);
    parent = id;
  }
  return { entries, texts, ids };
}
