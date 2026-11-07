import { randomUUID } from "node:crypto";
import type { EntryBody, Log, LogEntry } from "@sakura/kernel";
import { projectMessages } from "./projection.ts";
import { createTree } from "./tree.ts";

export interface LogOptions {
  now?: () => number;
  newId?: () => string;
}

/** A session log that can go back to an earlier entry and carry on from there. */
export interface RewindableLog extends Log {
  /** Moves the end of the conversation back to an earlier entry (or to the very start with null). Later entries start a new branch. */
  rewindTo(entryId: string | null): void;
  /** Id of the entry the next one will follow. */
  leaf(): string | null;
}

/** A log that lives only in memory (or wraps entries that were loaded elsewhere). */
export function createMemoryLog(options: LogOptions & { entries?: readonly LogEntry[] } = {}): RewindableLog {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => randomUUID().slice(0, 8));
  const tree = createTree(options.entries ?? []);

  return {
    async append(body: EntryBody): Promise<LogEntry> {
      const entry = { ...body, id: newId(), parentId: tree.leaf(), ts: now() } as LogEntry;
      tree.add(entry);
      return entry;
    },
    async branch() {
      return tree.branch();
    },
    async project(upTo?: string) {
      const branch = tree.branch();
      return projectMessages(
        upTo === undefined
          ? branch
          : branch.slice(
              0,
              Math.max(
                0,
                branch.findIndex((entry) => entry.id === upTo),
              ),
            ),
      );
    },
    rewindTo: (entryId) => tree.moveLeaf(entryId),
    leaf: () => tree.leaf(),
  };
}
