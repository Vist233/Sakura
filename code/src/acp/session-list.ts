import { isAbsolute } from "node:path";
import type { SessionStore } from "../session-store.ts";
import { AcpError, ErrorCode } from "./types.ts";
import type { ListSessionsParams, ListSessionsResult } from "./types.ts";

const PAGE_SIZE = 50;

export async function listSessions(store: SessionStore, { cwd, cursor }: ListSessionsParams): Promise<ListSessionsResult> {
  if (cwd != null && !isAbsolute(cwd)) throw new AcpError(ErrorCode.invalidParams, "cwd must be an absolute path");
  const sessions = (await store.list({ ...(cwd != null ? { cwd } : {}) })).filter((session) => session.title !== undefined);
  const start = cursor == null ? 0 : sessions.findIndex((session) => session.id === cursor) + 1;
  if (cursor != null && start === 0) throw new AcpError(ErrorCode.invalidParams, "Unknown session list cursor");
  const page = sessions.slice(start, start + PAGE_SIZE);
  return {
    sessions: page.map((session) => ({
      sessionId: session.id,
      cwd: session.cwd,
      title: session.title!,
      updatedAt: new Date(session.updatedAt).toISOString(),
    })),
    ...(start + page.length < sessions.length ? { nextCursor: page.at(-1)!.id } : {}),
  };
}
