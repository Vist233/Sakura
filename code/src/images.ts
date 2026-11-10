// Image files: which paths are images, and how a pasted or dropped path is read.
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

export function imageMediaType(path: string): string | undefined {
  return IMAGE_TYPES[extname(path).toLowerCase()];
}

/** The existing image file a pasted text names (a terminal drop gives a path, maybe quoted or with escaped spaces), or undefined. */
export function pastedImagePath(text: string, cwd: string): string | undefined {
  let candidate = text.trim();
  if (candidate === "" || candidate.includes("\n")) return undefined;
  candidate = candidate.replace(/^(['"])(.*)\1$/, "$2").replace(/\\ /g, " ").replace(/^file:\/\//, "");
  if (imageMediaType(candidate) === undefined) return undefined;
  const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}
