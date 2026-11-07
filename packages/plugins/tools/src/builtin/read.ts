import type { Tool, ToolResult } from "@sakura/kernel";
import { DEFAULT_FOLD, foldHead } from "../fold.ts";
import { ArgumentError, optionalInteger, requireString } from "./args.ts";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/*
 * Description adapted from Pi's read tool (MIT, Copyright (c) 2025 Mario Zechner; see THIRD_PARTY_NOTICES.md).
 */
export const readTool: Tool = {
  name: "read",
  description:
    "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp); images are sent as attachments. " +
    "For text files, output is truncated to the first 2000 lines or 50KB, whichever is hit first. " +
    "Use offset and limit for large files, and continue with offset until you have the whole file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to read (relative or absolute)" },
      offset: { type: "integer", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "integer", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  effect: "read",
  async execute(args, { env }) {
    try {
      const path = requireString(args, "path");
      const offset = optionalInteger(args, "offset", 1);
      const limit = optionalInteger(args, "limit", 1);
      const absolute = env.resolve(path);
      const info = await env.stat(absolute);
      if (!info) return fail(`File not found: ${path}`);
      if (info.isDirectory) return fail(`${path} is a directory, not a file.`);

      const extension = absolute.slice(absolute.lastIndexOf(".")).toLowerCase();
      const mediaType = IMAGE_TYPES[extension];
      if (mediaType) {
        return {
          content: [
            { type: "text", text: `Read image file [${mediaType}]` },
            { type: "image", mediaType, ref: absolute },
          ],
        };
      }

      const bytes = await env.readFile(absolute);
      if (bytes.subarray(0, 8000).includes(0)) return fail(`${path} looks like a binary file and cannot be shown as text.`);
      const text = new TextDecoder().decode(bytes);
      const lines = text === "" ? [] : text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = (offset ?? 1) - 1;
      if (lines.length === 0) return ok("");
      if (start >= lines.length) return fail(`Offset ${offset} is beyond the end of the file (${lines.length} lines in total).`);

      const selected = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit);
      const folded = foldHead(selected.join("\n"), DEFAULT_FOLD);
      const lastShown = start + folded.shownLines;
      let output = folded.text;
      if (folded.truncated) {
        output += `\n\n[Showing lines ${start + 1}-${lastShown} of ${lines.length}. Use offset=${lastShown + 1} to continue.]`;
      } else if (limit !== undefined && start + selected.length < lines.length) {
        output += `\n\n[${lines.length - start - selected.length} more lines in file. Use offset=${start + selected.length + 1} to continue.]`;
      }
      return ok(output);
    } catch (error) {
      if (error instanceof ArgumentError) return fail(error.message);
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
