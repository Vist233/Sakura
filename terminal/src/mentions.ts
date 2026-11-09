// `@path` mentions in a prompt: files that exist are named to the agent so that it reads them.
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { imageMediaType } from "./images.ts";
import { MENTION_NOTE } from "./transcript.ts";

const MENTION = /(^|\s)@([^\s@]+)/g;

export interface MentionResult {
  text: string;
  /** Files and directories that are named to the agent. */
  files: string[];
  /** Image files, which are attached to the message itself. */
  images: string[];
}

export async function expandMentions(prompt: string, cwd: string, home: string | undefined): Promise<MentionResult> {
  const candidates = [...prompt.matchAll(MENTION)].map((match) => match[2]!.replace(/[.,;:!?)\]]+$/, ""));
  const files: string[] = [];
  const images: string[] = [];
  for (const candidate of new Set(candidates)) {
    const path = candidate.startsWith("~/") && home ? resolve(home, candidate.slice(2)) : isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && imageMediaType(path)) images.push(path);
    else if (info) files.push(info.isDirectory() ? `${path}/` : path);
  }
  if (files.length === 0) return { text: prompt, files, images };
  return { text: `${prompt}${MENTION_NOTE}${files.map((file) => `- ${file}`).join("\n")}`, files, images };
}
