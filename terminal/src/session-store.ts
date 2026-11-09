// Where sessions live. The framework owns the conversation file (<id>.jsonl); this module adds a small metadata file beside it
// (<id>.meta.json) so that a session can be listed, found and titled without parsing the whole conversation.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  title?: string;
  /** The session this one was forked from. */
  parentId?: string;
  createdAt: number;
  updatedAt: number;
}

export type MetaPatch = Partial<Omit<SessionMeta, "id" | "createdAt">>;

export interface SessionStore {
  readonly root: string;
  /** Registers a new session (the conversation file is created by the framework on first use). */
  create(input: { cwd: string; provider: string; model: string; parentId?: string }): Promise<SessionMeta>;
  sessionFile(id: string): string;
  get(id: string): Promise<SessionMeta | undefined>;
  update(id: string, patch: MetaPatch): Promise<SessionMeta>;
  /** Deletes a session and its conversation file (used for sessions that never got a prompt). */
  remove(id: string): Promise<void>;
  /** Newest first. */
  list(filter?: { cwd?: string }): Promise<SessionMeta[]>;
  /** An id, a unique id prefix, "last", or the path of a session file. */
  find(reference: string, filter?: { cwd?: string }): Promise<SessionMeta | undefined>;
}

export class SessionLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLookupError";
  }
}

export function createSessionStore(root: string, options: { now?: () => number } = {}): SessionStore {
  const now = options.now ?? Date.now;
  const metaPath = (id: string) => join(root, `${id}.meta.json`);

  async function write(meta: SessionMeta): Promise<void> {
    await mkdir(root, { recursive: true });
    const temporary = `${metaPath(meta.id)}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`);
    await rename(temporary, metaPath(meta.id));
  }

  async function get(id: string): Promise<SessionMeta | undefined> {
    try {
      return JSON.parse(await readFile(metaPath(id), "utf8")) as SessionMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function list(filter: { cwd?: string } = {}): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const metas = await Promise.all(names.filter((name) => name.endsWith(".meta.json")).map((name) => get(name.slice(0, -".meta.json".length)).catch(() => undefined)));
    return metas
      .filter((meta): meta is SessionMeta => meta !== undefined && (filter.cwd === undefined || meta.cwd === filter.cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return {
    root,
    sessionFile: (id) => join(root, `${id}.jsonl`),
    get,
    list,
    async create(input) {
      const stamp = now();
      const meta: SessionMeta = { id: randomUUID(), cwd: input.cwd, provider: input.provider, model: input.model, ...(input.parentId ? { parentId: input.parentId } : {}), createdAt: stamp, updatedAt: stamp };
      await write(meta);
      return meta;
    },
    async update(id, patch) {
      const current = await get(id);
      if (!current) throw new SessionLookupError(`no session ${id}`);
      const next: SessionMeta = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), updatedAt: now() };
      await write(next);
      return next;
    },
    async remove(id) {
      await rm(metaPath(id), { force: true });
      await rm(join(root, `${id}.jsonl`), { force: true });
    },
    async find(reference, filter = {}) {
      if (reference === "last") return (await list(filter))[0];
      if (reference.endsWith(".jsonl")) return get(basename(reference, ".jsonl"));
      const exact = await get(reference);
      if (exact) return exact;
      const matches = (await list(filter)).filter((meta) => meta.id.startsWith(reference));
      if (matches.length > 1) throw new SessionLookupError(`"${reference}" matches ${matches.length} sessions; give more characters`);
      return matches[0];
    },
  };
}

/** A one-line label for pickers: the title, or the id when the session has none yet. */
export function sessionLabel(meta: SessionMeta): string {
  return meta.title ?? `(untitled ${meta.id.slice(0, 8)})`;
}

/** The title is the first line of the first prompt, shortened. */
export function titleFromPrompt(prompt: string, limit = 60): string {
  const line = prompt.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
