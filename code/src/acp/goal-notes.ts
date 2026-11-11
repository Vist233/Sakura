// What the goal check found, as a short note for the person. The framework writes each check into the session log as a `custom`
// entry (`goal_check`, with the verdict and the checklist items) and sends no event for it, so the agent reads the log between
// turns. Pure.
import type { LogEntry } from "../framework.ts";

export interface GoalCheck {
  verdict: string;
  items: Array<{ status: string; text: string; note: string }>;
}

/** The goal checks in a log, oldest first. */
export function goalChecks(entries: readonly LogEntry[]): GoalCheck[] {
  const checks: GoalCheck[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "goal_check") continue;
    const data = entry.data as { verdict?: unknown; items?: unknown } | null;
    if (typeof data?.verdict !== "string") continue;
    const items = Array.isArray(data.items) ? data.items.flatMap((item) => (item && typeof item === "object" ? [{ status: String((item as { status?: unknown }).status ?? ""), text: String((item as { text?: unknown }).text ?? ""), note: String((item as { note?: unknown }).note ?? "") }] : [])) : [];
    checks.push({ verdict: data.verdict, items });
  }
  return checks;
}

/** One check as text; none for a check that found the goal complete (the `goal` event says so). */
export function describeCheck(check: GoalCheck): string | undefined {
  if (check.verdict === "complete") return undefined;
  const open = check.items.filter((item) => item.status !== "done");
  const lines = open.map((item) => `- ${item.text}${item.note ? ` (${item.note})` : ""}`).join("\n");
  const head = check.verdict === "needs_human" ? "Goal check: these items need you to act or decide:" : "Goal check: the goal is not finished yet. Remaining items:";
  return `\n\n${head}\n${lines}\n`;
}
