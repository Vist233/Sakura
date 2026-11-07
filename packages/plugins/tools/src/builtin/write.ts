import type { Tool, ToolResult } from "@sakura/kernel";
import { ArgumentError, requireString } from "./args.ts";

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/*
 * Description adapted from Pi's write tool (MIT, Copyright (c) 2025 Mario Zechner; see THIRD_PARTY_NOTICES.md).
 */
export const writeTool: Tool = {
  name: "write",
  description:
    "Write content to a file. Creates the file and any missing parent directories, or overwrites an existing file completely. " +
    "Use it only for new files or complete rewrites; for changes to an existing file use edit. Keep each file under about 2000 lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to write (relative or absolute)" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  effect: "write",
  async execute(args, { env }) {
    try {
      const path = requireString(args, "path");
      const content = requireString(args, "content");
      const existing = await env.stat(env.resolve(path));
      if (existing?.isDirectory) return fail(`${path} is a directory.`);
      await env.writeFile(path, content);
      return { content: [{ type: "text", text: `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}` }] };
    } catch (error) {
      if (error instanceof ArgumentError) return fail(error.message);
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
