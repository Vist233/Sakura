import type { Content, LogEntry } from "@sakura/kernel";

export interface ViewOptions {
  /** How many of the latest items to show. */
  last: number;
  /** Show the agent's reasoning blocks (cut short). Off by default. */
  thinking: boolean;
  /** Longest text shown for one item. */
  maxChars?: number;
}

export type ChildStatus = "running" | "idle" | "completed" | "failed" | "stopped";

export interface ChildSummary {
  id: string;
  name: string;
  status: ChildStatus;
  turns: number;
  tokens: number;
  lastActivity: number | undefined;
}

const textOf = (content: Content[]): string =>
  content
    .map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : ""))
    .join("")
    .trim();
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [cut, ${text.length - max} more characters]` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function summarize(id: string, name: string, status: ChildStatus, entries: readonly LogEntry[]): ChildSummary {
  let turns = 0;
  let tokens = 0;
  let lastActivity: number | undefined;
  for (const entry of entries) {
    lastActivity = entry.ts;
    if (entry.type === "message" && entry.message.role === "assistant") turns++;
    const usage = entry.type === "message" ? entry.message.usage : entry.type === "usage" ? entry.usage : undefined;
    if (usage) tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  return { id, name, status, turns, tokens, lastActivity };
}

/**
 * Turns another agent's log into something a model can read: one status line, then the latest items
 * as short lines. Raw log lines are never shown. This is for the parent agent, not for people.
 */
export function renderChild(summary: ChildSummary, entries: readonly LogEntry[], options: ViewOptions): string {
  const max = options.maxChars ?? 600;
  const lines: string[] = [];
  const callNames = new Map<string, { name: string; args: unknown }>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "user") lines.push(`user: ${cut(oneLine(textOf(message.content)), max)}`);
    else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) lines.push(`assistant: ${cut(oneLine(part.text), max)}`);
        if (part.type === "provider" && options.thinking) {
          const reasoning = (part.data as { reasoning?: string } | undefined)?.reasoning;
          if (reasoning) lines.push(`thinking: ${cut(oneLine(reasoning), 300)}`);
        }
        if (part.type === "tool_call") {
          callNames.set(part.id, { name: part.name, args: part.args });
          lines.push(`tool ${part.name} ${cut(oneLine(JSON.stringify(part.args ?? {})), 200)}`);
        }
      }
    } else if (message.role === "tool") {
      const call = callNames.get(message.toolCallId ?? "");
      lines.push(`tool result${call ? ` (${call.name})` : ""}${message.isError ? " [error]" : ""}: ${cut(oneLine(textOf(message.content)), max)}`);
    }
  }
  const shown = lines.slice(-Math.max(1, options.last));
  const when = summary.lastActivity ? new Date(summary.lastActivity).toISOString() : "never";
  const header = `agent ${summary.id} (${summary.name}): ${summary.status}, ${summary.turns} turns, ${summary.tokens} tokens, last activity ${when}`;
  const omitted = lines.length - shown.length;
  return [header, ...(omitted > 0 ? [`(${omitted} earlier items not shown)`] : []), ...shown].join("\n");
}
