import type { LogEntry } from "@sakura/kernel";
import { createLog } from "./log-core.ts";
import type { LogOptions, RewindableLog } from "./log-core.ts";
import { createTree } from "./tree.ts";

export type { LogOptions, RewindableLog } from "./log-core.ts";

/** A log that lives only in memory (or wraps entries that were loaded elsewhere). */
export function createMemoryLog(options: LogOptions & { entries?: readonly LogEntry[] } = {}): RewindableLog {
  const { settled: _settled, ...log } = createLog(createTree(options.entries ?? []), { saveEntry: async () => undefined, saveRewind: async () => undefined }, options);
  return log;
}
