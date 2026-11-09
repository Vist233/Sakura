import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

/** Thrown when a confined environment is asked for something outside its working directory. */
export class OutsideDirectoryError extends Error {
  readonly path: string;
  readonly root: string;
  constructor(path: string, root: string) {
    super(`${path} is outside the working directory ${root}`);
    this.name = "OutsideDirectoryError";
    this.path = path;
    this.root = root;
  }
}

/** Whether an absolute, normalised path is the root or below it, by text ("/work-evil" is not inside "/work"). */
export const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Where a path really is, following links, for a path that may not exist yet: the real location of its deepest existing ancestor, plus the
 * names below it. A link that points nowhere is not followed blindly (writing through it would create its target): it counts as outside.
 */
export async function realLocation(path: string, root: string): Promise<string> {
  const below: string[] = [];
  let current = path;
  while (true) {
    try {
      return resolve(await realpath(current), ...below.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (
        await lstat(current).then(
          () => true,
          () => false,
        )
      )
        throw new OutsideDirectoryError(path, root); // a dangling link
      const parent = dirname(current);
      if (parent === current) throw error;
      below.push(basename(current));
      current = parent;
    }
  }
}
