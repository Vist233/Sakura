import type { GoalRecord } from "./types.ts";

export type ItemStatus = "done" | "todo" | "human";
export interface ChecklistItem {
  status: ItemStatus;
  text: string;
  note: string;
}

/** Reads lines such as "- [done] item :: evidence". Lines in any other format are ignored. */
export function parseChecklist(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*[-*]?\s*\[(done|todo|human)\]\s*(.*)$/i);
    if (!match) continue;
    const [text, note = ""] = (match[2] ?? "").split("::").map((part) => part.trim());
    items.push({ status: (match[1] ?? "todo").toLowerCase() as ItemStatus, text: text ?? "", note });
  }
  return items;
}

export type GoalVerdict = { kind: "complete" } | { kind: "continue"; remaining: ChecklistItem[] } | { kind: "needs_human"; remaining: ChecklistItem[] };

/**
 * Decides what a checklist means. An unreadable or empty checklist counts as "not done" so that a
 * model that ignores the format cannot finish the goal by accident.
 */
export function judgeChecklist(items: readonly ChecklistItem[]): GoalVerdict {
  const todo = items.filter((item) => item.status === "todo");
  const human = items.filter((item) => item.status === "human");
  if (items.length === 0) return { kind: "continue", remaining: [{ status: "todo", text: "The goal check could not be read. List every item with [done], [todo] or [human].", note: "" }] };
  if (todo.length > 0) return { kind: "continue", remaining: todo };
  if (human.length > 0) return { kind: "needs_human", remaining: human };
  return { kind: "complete" };
}

export const BLOCKED_AFTER = 3;

export function describeRemaining(items: readonly ChecklistItem[]): string {
  return items.map((item) => `- ${item.text}${item.note ? ` (${item.note})` : ""}`).join("\n");
}

export const newGoal = (objective: string, verify?: string): GoalRecord => ({
  objective,
  ...(verify !== undefined ? { verify } : {}),
  status: "active",
  humanStreak: 0,
});
