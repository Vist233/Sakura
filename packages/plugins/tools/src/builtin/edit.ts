import type { Tool, ToolResult } from "@sakura/kernel";
import { applyEdits, detectLineEnding, normalizeToLF, restoreLineEndings, splitBom } from "../edit-match.ts";
import type { Edit } from "../edit-match.ts";
import { ArgumentError, arrayOf, rawRecord, requireString } from "./args.ts";

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Accepts the old single-edit form (oldText/newText at the top level) as well as edits[]. */
function readEdits(args: unknown): Edit[] {
  const record = rawRecord(args);
  const edits = record.edits === undefined ? [] : arrayOf(args, "edits");
  const list = edits.map((item, index) => {
    const entry = item as Record<string, unknown> | null;
    if (typeof entry?.oldText !== "string" || typeof entry?.newText !== "string") {
      throw new ArgumentError(`edits[${index}] must have string oldText and newText.`);
    }
    return { oldText: entry.oldText, newText: entry.newText };
  });
  if (typeof record.oldText === "string" && typeof record.newText === "string") {
    list.push({ oldText: record.oldText, newText: record.newText });
  }
  if (list.length === 0) throw new ArgumentError("Provide at least one edit in edits[].");
  return list;
}

/*
 * Description adapted from Pi's edit tool (MIT, Copyright (c) 2025 Mario Zechner; see THIRD_PARTY_NOTICES.md).
 */
export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. " +
    "If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. " +
    "Do not include large unchanged regions just to connect distant changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to edit (relative or absolute)" },
      edits: {
        type: "array",
        description: "One or more targeted replacements, all matched against the original file.",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to replace. Must be unique in the file and must not overlap other edits." },
            newText: { type: "string", description: "Replacement text." },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  effect: "write",
  async execute(args, { env }) {
    try {
      const path = requireString(args, "path");
      const edits = readEdits(args);
      const absolute = env.resolve(path);
      const info = await env.stat(absolute);
      if (!info) return fail(`File not found: ${path}`);
      if (info.isDirectory) return fail(`${path} is a directory.`);

      const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await env.readFile(absolute)); // keep the BOM so it can be restored
      const { bom, text } = splitBom(raw); // the model never includes an invisible BOM in oldText
      const ending = detectLineEnding(text);
      const updated = applyEdits(normalizeToLF(text), edits, path);
      await env.writeFile(absolute, bom + restoreLineEndings(updated, ending));
      return { content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }] };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
