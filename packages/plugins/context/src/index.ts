import type { Environment, Log, Plugin } from "@sakura/kernel";

export interface ContextOptions {
  /** Load the AGENTS.md in the working directory. Default true. */
  cwd?: boolean;
  /** Path of a user-level AGENTS.md (for example ~/.config/agent/AGENTS.md). Off by default. */
  userFile?: string | false;
  fileName?: string;
  /** Longer files are cut with a note. Default 32 KB. */
  maxBytes?: number;
}

export interface ContextPlugin extends Plugin {
  /**
   * Read the files again and, if they changed, add a new pinned message that replaces the earlier
   * instructions. Called by hand, and by the kernel after every compaction; nothing else re-reads files.
   */
  reload(context: { log: Log; env: Environment }): Promise<boolean>;
}

const CUSTOM_TYPE = "agents_md";

interface Source {
  label: string;
  path: string;
}

async function readSource(env: Environment, source: Source, maxBytes: number): Promise<string | undefined> {
  const info = await env.stat(source.path);
  if (!info?.isFile) return undefined;
  const bytes = await env.readFile(source.path);
  const text = new TextDecoder().decode(bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes).trim();
  if (text === "") return undefined;
  const note = bytes.length > maxBytes ? `\n\n[The file was cut after ${maxBytes} bytes.]` : "";
  return `Instructions from ${source.label} (${source.path}):\n\n${text}${note}`;
}

/**
 * Puts project instructions (AGENTS.md) at the start of the conversation as a pinned message, once.
 * They survive compaction and are not summarised. Only the AGENTS.md name is understood; there is no
 * parent-directory search, no per-directory loading and no @path includes.
 */
export function contextPlugin(options: ContextOptions = {}): ContextPlugin {
  const fileName = options.fileName ?? "AGENTS.md";
  const maxBytes = options.maxBytes ?? 32 * 1024;

  async function load(env: Environment): Promise<string | undefined> {
    const sources: Source[] = [];
    if (options.userFile) sources.push({ label: "the user's global file", path: options.userFile });
    if (options.cwd !== false) sources.push({ label: "this project", path: env.resolve(fileName) });
    const parts: string[] = [];
    for (const source of sources) {
      const part = await readSource(env, source, maxBytes);
      if (part) parts.push(part);
    }
    return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
  }

  const pinnedTexts = async (log: Log): Promise<string[]> =>
    (await log.branch()).flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === CUSTOM_TYPE ? [entry.content.map((part) => (part.type === "text" ? part.text : "")).join("")] : [],
    );

  /** Reads the files again; if they changed, adds a new pinned message that replaces the earlier instructions. */
  async function reloadInstructions({ log, env }: { log: Log; env: Environment }): Promise<boolean> {
    const earlier = await pinnedTexts(log);
    const text = await load(env);
    if (text === undefined || text === earlier.at(-1)?.replace(/^These instructions replace all earlier project instructions\.\n\n/, "")) return false;
    await log.append({
      type: "custom_message",
      customType: CUSTOM_TYPE,
      pinned: true,
      content: [{ type: "text", text: `These instructions replace all earlier project instructions.\n\n${text}` }],
    });
    return true;
  }

  return {
    name: "context",
    compensates: "models start every session knowing nothing about the project's rules",
    setup: () => undefined,
    async prepare({ log, env }) {
      if ((await pinnedTexts(log)).length > 0) return;
      const text = await load(env);
      if (text) await log.append({ type: "custom_message", customType: CUSTOM_TYPE, pinned: true, content: [{ type: "text", text }] });
    },
    async afterCompaction(context) {
      await reloadInstructions(context);
    },
    reload: (context) => reloadInstructions(context),
  };
}
