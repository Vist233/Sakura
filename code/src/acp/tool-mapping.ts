// A tool call and its result as ACP shows them: a kind (the icon), a title, the files it touches, a diff for edits, text for output.
// Pure. Paths are made absolute against the session's directory; line numbers are 1-based.
import { resolve } from "node:path";
import type { ToolCall, ToolResult } from "../framework.ts";
import type { ToolContent, ToolKind, ToolLocation, ToolStatus } from "./types.ts";

/** Longest text kept in a card; the rest is replaced by a note that says how much was cut. */
export const MAX_CARD_TEXT = 20_000;
const MAX_TITLE = 120;

export interface CallContext {
  /** The session's directory; relative paths in the arguments are resolved against it. */
  cwd: string;
  /** What the file held before a `write`: the text, `null` when it did not exist, `undefined` when that is not known (yet). */
  previous?: string | null | undefined;
}

export interface CallCard {
  kind: ToolKind;
  title: string;
  locations: ToolLocation[];
  content: ToolContent[];
  rawInput: unknown;
}

export interface ResultCard {
  status: ToolStatus;
  content: ToolContent[];
  rawOutput: unknown;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined);

export function cut(value: string, max = MAX_CARD_TEXT): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} more characters not shown)`;
}

const oneLine = (value: string): string => {
  const line = value.trim().split("\n")[0] ?? "";
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line;
};

/** A copy of the arguments with every long string cut, so a card never carries a whole file twice. */
export function capped(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return cut(value);
  if (depth > 6) return "[nested too deep]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => capped(item, depth + 1));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, capped(item, depth + 1)]));
  return value;
}

function kindOf(name: string): ToolKind {
  switch (name) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    default:
      return /fetch|http|web|url/i.test(name) ? "fetch" : /search|grep|find|glob/i.test(name) ? "search" : "other";
  }
}

const textBlock = (value: string): ToolContent => ({ type: "content", content: { type: "text", text: value } });

export function describeCall(call: ToolCall, context: CallContext): CallCard {
  const args = record(call.args);
  const kind = kindOf(call.name);
  const rawPath = text(args.path);
  const path = rawPath === undefined || rawPath === "" ? undefined : resolve(context.cwd, rawPath);
  const rawInput = capped(call.args);
  switch (call.name) {
    case "read": {
      const offset = positive(args.offset);
      const limit = positive(args.limit);
      const range = offset === undefined ? "" : limit === undefined ? `:${offset}` : `:${offset}-${offset + limit - 1}`;
      return { kind, title: `Read ${rawPath ?? "a file"}${range}`, locations: path ? [{ path, ...(offset ? { line: offset } : {}) }] : [], content: [], rawInput };
    }
    case "write": {
      const body = text(args.content);
      // without knowing what the file held the diff would claim "a new file" for any file, so it waits for the snapshot
      const content: ToolContent[] = path && body !== undefined && context.previous !== undefined ? [{ type: "diff", path, oldText: context.previous === null ? null : cut(context.previous), newText: cut(body) }] : [];
      return { kind, title: `Write ${rawPath ?? "a file"}`, locations: path ? [{ path }] : [], content, rawInput };
    }
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.map(record) : [];
      const content: ToolContent[] = path
        ? edits.flatMap((edit) => {
            const oldText = text(edit.oldText);
            const newText = text(edit.newText);
            return oldText === undefined || newText === undefined ? [] : [{ type: "diff" as const, path, oldText: cut(oldText), newText: cut(newText) }];
          })
        : [];
      return { kind, title: `Edit ${rawPath ?? "a file"}${edits.length > 1 ? ` (${edits.length} changes)` : ""}`, locations: path ? [{ path }] : [], content, rawInput };
    }
    case "bash": {
      const command = text(args.command) ?? "";
      return { kind, title: command === "" ? "Run a command" : oneLine(command), locations: [], content: command === "" ? [] : [textBlock(`$ ${cut(command)}`)], rawInput };
    }
    default:
      return { kind, title: call.name, locations: path ? [{ path }] : [], content: [], rawInput };
  }
}

/**
 * The card after the tool ended. A failed call carries its error text; a finished edit or write keeps its diff (the update replaces
 * the content, so it is sent again); a command shows its command and its output.
 */
export function describeResult(call: ToolCall, result: ToolResult, context: CallContext): ResultCard {
  const output = result.content.flatMap((part) => (part.type === "text" ? [part.text] : part.type === "image" ? ["[image]"] : [])).join("\n");
  const status: ToolStatus = result.isError ? "failed" : "completed";
  const shown = output === "" ? [] : [textBlock(cut(output))];
  const start = describeCall(call, context);
  const keep = status === "completed" && (call.name === "edit" || call.name === "write") ? start.content : [];
  const lead = call.name === "bash" ? start.content : [];
  return { status, content: [...lead, ...keep, ...shown], rawOutput: { text: cut(output), ...(result.isError ? { isError: true } : {}) } };
}
