import type { LogEntry, UsageTotals } from "./types.ts";

/** Everything the session has spent, counted from the log (so it survives restarts). */
export function usageTotals(branch: readonly LogEntry[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const entry of branch) {
    const usage = entry.type === "message" ? entry.message.usage : entry.type === "usage" ? entry.usage : undefined;
    if (entry.type === "message" && entry.message.role === "assistant") totals.turns++;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
  }
  return totals;
}
