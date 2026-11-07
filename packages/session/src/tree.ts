import type { LogEntry } from "@sakura/kernel";

/**
 * The entries of one session as a tree. Every entry names its parent; the "leaf" is where the next entry attaches.
 * The current branch is the path from the root to the leaf. Moving the leaf back (rewinding) makes the next entry
 * start a new branch; the old branch stays.
 */
export function createTree(initial: readonly LogEntry[]) {
  const all: LogEntry[] = [...initial];
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  let leaf: string | null = all.at(-1)?.id ?? null;
  return {
    leaf: (): string | null => leaf,
    add(entry: LogEntry): void {
      all.push(entry);
      byId.set(entry.id, entry);
      leaf = entry.id;
    },
    moveLeaf(id: string | null): void {
      if (id !== null && !byId.has(id)) throw new Error(`no entry with id ${id}`);
      leaf = id;
    },
    /** From the root to the leaf. */
    branch(): LogEntry[] {
      const path: LogEntry[] = [];
      for (let at = leaf; at !== null; ) {
        const entry = byId.get(at);
        if (!entry) break;
        path.push(entry);
        at = entry.parentId;
      }
      return path.reverse();
    },
  };
}
