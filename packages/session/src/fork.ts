import { randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Log, LogEntry } from "@sakura/kernel";
import type { SessionHeader } from "./file-log.ts";

export interface ForkOptions {
  /** The last entry to copy, an id from `log.branch()`. Left out, the whole current branch is copied. */
  upTo?: string;
  /** The working directory to record in the new session. Default: this process's. */
  cwd?: string;
  /** The id of the session the log comes from, if it has one; recorded so that the new session says where it came from. */
  sessionId?: string;
}

/** Where to stop copying so that no turn is cut in two: after the results that answer the calls of the last assistant message that was copied. */
function endOfTurn(branch: readonly LogEntry[], last: number): number {
  let assistant = -1;
  for (let index = last; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.role === "assistant") {
      assistant = index;
      break;
    }
  }
  const opened = assistant >= 0 ? branch[assistant] : undefined;
  if (opened?.type !== "message") return last;
  const open = new Set(opened.message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : [])));
  for (let index = assistant + 1; index <= last; index++) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.toolCallId) open.delete(entry.message.toolCallId);
  }
  let end = last;
  while (open.size > 0 && end + 1 < branch.length) {
    const next = branch[end + 1] as LogEntry;
    if (next.type === "message" && next.message.role !== "tool") break; // a new turn begins: calls that were never answered stay as they were in the source
    end++;
    if (next.type === "message" && next.message.toolCallId) open.delete(next.message.toolCallId);
  }
  return end;
}

/**
 * Copies the conversation up to a point into a new session file, which is then a session of its own: its entries are the same entries (same ids, same
 * parents), so what the model is sent from it is exactly what it was sent from the original at that point, and a provider's prompt cache still applies.
 * The source is only read. The file appears whole or not at all, and an existing file is never replaced.
 */
export async function forkLog(log: Log, path: string, options: ForkOptions = {}): Promise<SessionHeader> {
  const branch = await log.branch();
  let last = branch.length - 1;
  if (options.upTo !== undefined) {
    last = branch.findIndex((entry) => entry.id === options.upTo);
    if (last === -1) throw new Error(`entry ${options.upTo} is not on the current branch`);
  }
  const copied = branch.slice(0, endOfTurn(branch, last) + 1);
  const header: SessionHeader = {
    type: "header",
    version: 1,
    id: randomUUID().slice(0, 8),
    cwd: options.cwd ?? process.cwd(),
    ts: Date.now(),
    ...(copied.length > 0 ? { forkedFrom: { entry: (copied.at(-1) as LogEntry).id, ...(options.sessionId !== undefined ? { session: options.sessionId } : {}) } } : {}),
  };
  const text = [header, ...copied].map((line) => `${JSON.stringify(line)}\n`).join("");

  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    // a hard link fails if the target exists, so a session that is there is never replaced, and the new one never shows up half written
    await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "EEXIST" ? new Error(`${path} already exists`) : error;
    });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return header;
}
