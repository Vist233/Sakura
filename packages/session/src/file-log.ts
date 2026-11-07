import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EntryBody, LogEntry } from "@sakura/kernel";
import type { LogOptions, RewindableLog } from "./memory-log.ts";
import { projectMessages } from "./projection.ts";
import { createTree } from "./tree.ts";

const FORMAT_VERSION = 1;

export interface SessionHeader {
  type: "header";
  version: number;
  id: string;
  cwd: string;
  ts: number;
}

export interface FileLog extends RewindableLog {
  header: SessionHeader;
  /** Releases the single-writer lock. */
  close(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
    if (Number.isFinite(owner) && isProcessAlive(owner)) {
      throw new Error(`session is already open in process ${owner}`);
    }
    await writeFile(lockPath, String(process.pid)); // stale lock from a crashed process
  }
}

interface Parsed {
  header: SessionHeader;
  entries: LogEntry[];
  /** Byte length of the valid part of the file (everything after it is a torn write). */
  validBytes: number;
}

function parseFile(text: string): Parsed {
  const lines = text.split("\n");
  const complete = lines.slice(0, -1); // the last piece has no trailing newline: it is empty or a torn write
  let header: SessionHeader | undefined;
  const entries: LogEntry[] = [];
  let validBytes = 0;
  for (const [index, line] of complete.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`corrupt session file: line ${index + 1} is not valid JSON`);
    }
    if (index === 0) {
      header = value as SessionHeader;
      if (header.type !== "header") throw new Error("corrupt session file: first line is not a header");
      if (header.version > FORMAT_VERSION) throw new Error(`session file version ${header.version} is newer than supported`);
    } else {
      entries.push(value as LogEntry);
    }
    validBytes += Buffer.byteLength(line) + 1;
  }
  if (!header) throw new Error("corrupt session file: missing header");
  return { header, entries, validBytes };
}

/**
 * One JSONL file per session: a header line, then one complete entry per line.
 * Only one process may hold a session open; a torn last line from a crash is discarded on open.
 */
export async function openFileLog(path: string, options: LogOptions & { cwd?: string } = {}): Promise<FileLog> {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => randomUUID().slice(0, 8));
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath);

  let header: SessionHeader;
  let entries: LogEntry[];
  try {
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined || existing === "") {
      header = { type: "header", version: FORMAT_VERSION, id: newId(), cwd: options.cwd ?? process.cwd(), ts: now() };
      await writeFile(path, `${JSON.stringify(header)}\n`);
      entries = [];
    } else {
      const parsed = parseFile(existing);
      header = parsed.header;
      entries = parsed.entries;
      if (parsed.validBytes < Buffer.byteLength(existing)) await truncate(path, parsed.validBytes);
    }
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }

  const tree = createTree(entries);
  let writing: Promise<unknown> = Promise.resolve();
  return {
    header,
    async append(body: EntryBody): Promise<LogEntry> {
      const entry = { ...body, id: newId(), parentId: tree.leaf(), ts: now() } as LogEntry;
      tree.add(entry);
      writing = writing.then(() => appendFile(path, `${JSON.stringify(entry)}\n`));
      await writing;
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
    async close() {
      await writing;
      await rm(lockPath, { force: true });
    },
  };
}
