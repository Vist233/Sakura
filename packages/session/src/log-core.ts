import { randomUUID } from "node:crypto";
import type { EntryBody, Log, LogEntry } from "@sakura/kernel";
import { projectMessages } from "./projection.ts";
import type { createTree } from "./tree.ts";

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

/** Where a log keeps its entries. A memory log keeps them nowhere else. */
export interface Storage {
  /** Makes the entry durable. If this fails the entry is not part of the log. */
  saveEntry(entry: LogEntry): Promise<void>;
  /** Records that the end of the conversation moved. Best effort: the next entry carries the same information, so a lost record only matters if nothing follows. */
  saveRewind(to: string | null): Promise<void>;
}

/**
 * The one implementation of "a log": entries in a tree, one leaf, appends in order. The log is only as durable as its storage, and a log and its
 * storage never disagree: an entry joins the tree after it is saved, and an append that fails changes nothing and does not stop the ones after it.
 */
export function createLog(tree: ReturnType<typeof createTree>, storage: Storage, options: LogOptions = {}) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => randomUUID().slice(0, 8));
  // Appends run one after another, each starting from where the one before ended. A failed one is reported to its caller and not to the next.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    /** Resolves when everything started so far has been saved or has failed. */
    settled: () =>
      queue.then(
        () => undefined,
        () => undefined,
      ),
    append(body: EntryBody): Promise<LogEntry> {
      const run = queue.then(async () => {
        const entry = { ...body, id: newId(), parentId: tree.leaf(), ts: now() } as LogEntry;
        await storage.saveEntry(entry);
        tree.add(entry);
        return entry;
      });
      queue = run.catch(() => undefined);
      return run;
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
    /**
     * Takes effect at once. Entries that were already waiting to be saved follow the new end, so do not rewind while appends are in flight
     * (the kernel does not: one run at a time, and it waits for each append).
     */
    rewindTo(entryId: string | null): void {
      const before = tree.leaf();
      tree.moveLeaf(entryId);
      if (entryId === before) return;
      queue = queue.then(() => storage.saveRewind(entryId)).catch(() => undefined);
    },
    leaf: () => tree.leaf(),
  };
}
