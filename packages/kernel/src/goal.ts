import type { GoalRecord, Log, LogEntry } from "./types.ts";

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

/** The goal of the conversation as the log says it is now: the last goal entry on the branch. */
export function currentGoal(branch: readonly LogEntry[]): GoalRecord | undefined {
  const entry = [...branch].reverse().find((candidate) => candidate.type === "goal");
  return entry?.type === "goal" ? entry.goal : undefined;
}

/** Takes the earlier "your goal is ..." messages out of the context, so the model is told about one goal only. */
async function withdrawGoalMessages(log: Log): Promise<void> {
  const branch = await log.branch();
  const withdrawn = new Set(branch.flatMap((entry) => (entry.type === "context_edit" ? [entry.targetId] : [])));
  for (const entry of branch) {
    if (entry.type === "custom_message" && entry.customType === "goal" && !withdrawn.has(entry.id)) await log.append({ type: "context_edit", targetId: entry.id, replacement: null });
  }
}

/** Starts a goal: the record, and a pinned message that tells the model about it. A goal that was there before is replaced. The one place that writes a new goal. */
export async function startGoal(log: Log, goal: { objective: string; verify?: string }, statement: string): Promise<void> {
  await withdrawGoalMessages(log);
  await log.append({ type: "goal", goal: newGoal(goal.objective, goal.verify) });
  await log.append({ type: "custom_message", customType: "goal", pinned: true, content: [{ type: "text", text: statement }] });
}

/** Ends the goal by hand: it counts as complete and the model is no longer told about it. Does nothing when there is no goal or it has ended. */
export async function endGoal(log: Log): Promise<void> {
  const goal = currentGoal(await log.branch());
  if (!goal || goal.status === "complete") return;
  await withdrawGoalMessages(log);
  await log.append({ type: "goal", goal: { ...goal, status: "complete", humanStreak: 0 } });
}
