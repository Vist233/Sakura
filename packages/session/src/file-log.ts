import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry } from "@sakura/kernel";
import { createLog } from "./log-core.ts";
import type { LogOptions, RewindableLog } from "./log-core.ts";
import { createTree } from "./tree.ts";

const FORMAT_VERSION = 1;

export interface SessionHeader {
  type: "header";
  version: number;
  id: string;
  cwd: string;
  ts: number;
  /** Set on a session that was made by forking another: the entry it was copied up to, and the session it came from when that is known. */
  forkedFrom?: { entry: string; session?: string };
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
  /** Where the conversation was rewound to after the last entry, if it was (null is the very start). */
  rewoundTo?: string | null;
}

/** A line that is not an entry: the end of the conversation moved back. The entry that follows it carries the same information; this line is for when none does. */
interface RewindLine {
  type: "rewind";
  to: string | null;
}

function parseFile(text: string): Parsed {
  const lines = text.split("\n");
  const complete = lines.slice(0, -1); // the last piece has no trailing newline: it is empty or a torn write
  let header: SessionHeader | undefined;
  const entries: LogEntry[] = [];
  let rewoundTo: string | null | undefined;
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
    } else if ((value as { type?: unknown }).type === "rewind") {
      rewoundTo = (value as RewindLine).to;
    } else {
      entries.push(value as LogEntry);
      rewoundTo = undefined;
    }
    validBytes += Buffer.byteLength(line) + 1;
  }
  if (!header) throw new Error("corrupt session file: missing header");
  return { header, entries, validBytes, ...(rewoundTo !== undefined ? { rewoundTo } : {}) };
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
  let rewoundTo: string | null | undefined;
  let size: number; // bytes of the file that are known to be good
  try {
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined || existing === "") {
      header = { type: "header", version: FORMAT_VERSION, id: newId(), cwd: options.cwd ?? process.cwd(), ts: now() };
      const line = `${JSON.stringify(header)}\n`;
      await writeFile(path, line);
      entries = [];
      size = Buffer.byteLength(line);
    } else {
      const parsed = parseFile(existing);
      header = parsed.header;
      entries = parsed.entries;
      rewoundTo = parsed.rewoundTo;
      size = parsed.validBytes;
      if (size < Buffer.byteLength(existing)) await truncate(path, size);
    }
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }

  const tree = createTree(entries);
  if (rewoundTo !== undefined && (rewoundTo === null || entries.some((entry) => entry.id === rewoundTo))) tree.moveLeaf(rewoundTo);

  // A write that fails can leave half a line behind. The next write first cuts the file back to what is known to be good, so that half line
  // never ends up in the middle of the file where it would make the whole session unreadable.
  let damaged = false;
  async function write(line: string): Promise<void> {
    try {
      if (damaged) {
        await truncate(path, size);
        damaged = false;
      }
      await appendFile(path, line);
      size += Buffer.byteLength(line);
    } catch (error) {
      damaged = true;
      throw error;
    }
  }
  const log = createLog(
    tree,
    {
      saveEntry: (entry) => write(`${JSON.stringify(entry)}\n`),
      saveRewind: (to) => write(`${JSON.stringify({ type: "rewind", to } satisfies RewindLine)}\n`),
    },
    options,
  );
  return {
    header,
    append: log.append,
    branch: log.branch,
    project: log.project,
    rewindTo: log.rewindTo,
    leaf: log.leaf,
    async close() {
      await log.settled();
      await rm(lockPath, { force: true });
    },
  };
}
