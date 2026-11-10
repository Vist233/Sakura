// The view-model of a conversation. A reducer turns the framework's events (and, on resume, the session log) into blocks
// that a view can print. It knows nothing about terminals.
import type { Content, Event, LogEntry, Message, ToolCall, ToolResult } from "./framework.ts";

export type ToolStatus = "running" | "ok" | "error" | "denied";

export interface ReviewNote {
  outcome: "allow" | "deny";
  decidedBy: string;
  reason: string;
}

export interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  /** One line that says what the call does: the command, the file. */
  summary: string;
  status: ToolStatus;
  /** Exit code of a shell command that failed (read from the tool's message). */
  exitCode?: number;
  /** The first lines of the result. */
  output: string[];
  /** Lines of output that were left out. */
  hidden: number;
  /** For edits: removed and added lines. */
  diff?: string[];
  review?: ReviewNote;
}

export type Block =
  | { kind: "user"; text: string }
  /** `first` is true for the first block of a reply, which the view marks. */
  | { kind: "assistant"; text: string; first: boolean }
  | ToolBlock
  | { kind: "compaction"; tokensBefore: number }
  /** Information from the application itself (help, status), written in Markdown. */
  | { kind: "info"; markdown: string }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "shell"; command: string; output: string[]; hidden: number; exitCode: number | null };

export interface TranscriptState {
  /** Tools that have started and not ended. */
  running: ToolBlock[];
  /** Assistant text received but not yet committed (the last, unfinished block). */
  pending: string;
  /** A run is in progress. */
  working: boolean;
  /** Reasoning text of the reply being produced (shown briefly; never stored in the transcript). */
  reasoning: string;
}

export type TranscriptChange = { type: "commit"; block: Block } | { type: "state" };

export interface Transcript {
  apply(event: Event): void;
  /** Adds a block that did not come from an event (a notice, the output of `!command`). */
  add(block: Block): void;
  state(): TranscriptState;
  /** Everything committed so far, oldest first. */
  blocks(): readonly Block[];
  subscribe(listener: (change: TranscriptChange) => void): () => void;
  /** While muted, compaction events add no block (the caller says it in its own words). */
  muteCompaction(muted: boolean): void;
  /** Forgets everything (for /new, /clear). */
  reset(): void;
}

const OUTPUT_LINES = 8;

/** The assistant message the kernel appends when a request is cancelled before it was answered. */
export const INTERRUPTED_NOTE = "[The user interrupted this request before it was answered.]";

/** Added after a prompt that contains @paths (see mentions.ts); the view does not show it. */
export const MENTION_NOTE = "\n\nThe user pointed at these paths with @; look at them as needed:\n";

function withoutNote(text: string): string {
  // a canned prompt of a slash command starts with its name in brackets; the view shows only the name
  const command = /^\[(\/[a-z]+)\] /.exec(text);
  if (command) return command[1]!;
  const end = text.indexOf(MENTION_NOTE);
  return end === -1 ? text : text.slice(0, end);
}

export function createTranscript(): Transcript {
  let blocks: Block[] = [];
  let running = new Map<string, ToolBlock>();
  let compactionMuted = false;
  let pending = "";
  let streamedCommitted = 0;
  let firstOfReply = true;
  let working = false;
  const reviews = new Map<string, ReviewNote>();
  let reasoning = "";
  const listeners = new Set<(change: TranscriptChange) => void>();
  const notify = (change: TranscriptChange) => {
    for (const listener of listeners) listener(change);
  };
  const commit = (block: Block) => {
    blocks.push(block);
    notify({ type: "commit", block });
  };

  function commitAssistant(text: string) {
    if (text.trim() === "") return;
    commit({ kind: "assistant", text, first: firstOfReply });
    firstOfReply = false;
  }

  function streamText(delta: string) {
    pending += delta;
    const { done, rest } = splitCommittable(pending);
    for (const chunk of done) {
      streamedCommitted += chunk.length;
      commitAssistant(chunk);
    }
    pending = rest;
    notify({ type: "state" });
  }

  function endAssistant(message: Message) {
    reasoning = "";
    const full = textOf(message.content);
    if (full === INTERRUPTED_NOTE) return; // the kernel's marker for a cancelled request; "Run cancelled." already says it
    const alreadyShown = full.startsWith(textOfStreamed()) ? streamedCommitted : 0;
    const remainder = full.slice(alreadyShown);
    pending = "";
    streamedCommitted = 0;
    commitAssistant(remainder);
    firstOfReply = true; // the next message (after tool calls) starts with a mark again
    if (message.stop === "length") commit({ kind: "notice", level: "warn", text: "The reply was cut off because the output limit was reached." });
    notify({ type: "state" });
  }

  // the part of the message that was committed from the stream, kept to compare with the final text
  let streamedPrefix = "";
  const textOfStreamed = () => streamedPrefix;

  function toolStart(call: ToolCall) {
    const block = newToolBlock(call);
    const review = reviews.get(call.id);
    if (review) {
      block.review = review;
      reviews.delete(call.id);
    }
    reasoning = "";
    running.set(call.id, block);
    notify({ type: "state" });
  }

  function toolEnd(call: ToolCall, result: ToolResult) {
    const block = running.get(call.id) ?? newToolBlock(call);
    running.delete(call.id);
    const text = textOf(result.content);
    const denied = result.isError === true && text.startsWith("Not allowed:");
    block.status = denied ? "denied" : result.isError ? "error" : "ok";
    if (denied) {
      const note = reviews.get(call.id);
      if (note) block.review = note;
      reviews.delete(call.id);
    }
    const exit = /Command exited with code (\d+)\./.exec(text);
    if (exit) block.exitCode = Number.parseInt(exit[1]!, 10);
    const { lines, hidden } = excerpt(text, OUTPUT_LINES);
    block.output = lines;
    block.hidden = hidden;
    commit(block);
    notify({ type: "state" });
  }

  return {
    apply(event) {
      switch (event.type) {
        case "run_start":
          working = true;
          firstOfReply = true;
          notify({ type: "state" });
          break;
        case "run_end":
          working = false;
          reasoning = "";
          pending = "";
          streamedCommitted = 0;
          streamedPrefix = "";
          running = new Map();
          if (event.reason === "cancelled") commit({ kind: "notice", level: "warn", text: "Run cancelled." });
          notify({ type: "state" });
          break;
        case "reasoning_update":
          reasoning = (reasoning + event.delta).slice(-400);
          notify({ type: "state" });
          break;
        case "message_update":
          if (event.delta.type === "text") {
            streamedPrefix += event.delta.text;
            streamText(event.delta.text);
          }
          break;
        case "message_reset":
          if (streamedCommitted > 0) commit({ kind: "notice", level: "warn", text: "The connection dropped and the reply was started again." });
          pending = "";
          streamedCommitted = 0;
          streamedPrefix = "";
          notify({ type: "state" });
          break;
        case "message_end":
          if (event.message.role === "user") {
            const attached = event.message.content.flatMap((part) => (part.type === "image" ? [`[image: ${part.ref.split("/").pop()}]`] : []));
            const text = [withoutNote(textOf(event.message.content)), ...attached].filter((part) => part.trim() !== "").join("\n");
            if (text.trim() !== "") commit({ kind: "user", text });
            firstOfReply = true;
          } else if (event.message.role === "assistant") {
            endAssistant(event.message);
            streamedPrefix = "";
          }
          break;
        case "tool_start":
          toolStart(event.call);
          break;
        case "tool_end":
          toolEnd(event.call, event.result);
          break;
        case "compaction":
          if (!compactionMuted) commit({ kind: "compaction", tokensBefore: event.tokensBefore });
          break;
        case "paused":
          commit({ kind: "notice", level: "warn", text: `Run paused: ${event.reason}.` });
          break;
        case "goal":
          commit({ kind: "notice", level: "info", text: `Goal is ${event.status}.` });
          break;
        case "plugin":
          applyPluginEvent(event.name, event.data);
          break;
        default:
          break;
      }
    },
    add: commit,
    state: () => ({ running: [...running.values()], pending, working, reasoning }),
    blocks: () => blocks,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    muteCompaction(muted) {
      compactionMuted = muted;
    },
    reset() {
      blocks = [];
      running = new Map();
      pending = "";
      streamedCommitted = 0;
      streamedPrefix = "";
      reviews.clear();
      notify({ type: "state" });
    },
  };

  function applyPluginEvent(name: string, data: unknown) {
    if (name === "review" && isRecord(data) && data.kind === "review") {
      reviews.set(String(data.callId), { outcome: data.outcome === "deny" ? "deny" : "allow", decidedBy: String(data.decidedBy ?? ""), reason: String(data.reason ?? "") });
    } else if (isRecord(data) && typeof data.error === "string" && typeof data.hook === "string") {
      commit({ kind: "notice", level: "warn", text: `Plugin ${name} failed in ${data.hook}: ${data.error}` });
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function textOf(content: Content[]): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Splits streamed text into finished blocks (ended by a blank line outside a code fence) and the unfinished rest. */
export function splitCommittable(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let start = 0;
  let fence: string | undefined;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) break;
    const line = text.slice(lineStart, newline);
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fence === undefined) fence = marker[1]![0]!;
      else if (marker[1]![0] === fence) fence = undefined;
    }
    const next = text.indexOf("\n", newline + 1);
    const blankFollows = fence === undefined && next !== -1 && text.slice(newline + 1, next).trim() === "" && line.trim() !== "";
    if (blankFollows) {
      done.push(text.slice(start, next + 1));
      start = next + 1;
      lineStart = next + 1;
      continue;
    }
    lineStart = newline + 1;
  }
  return { done, rest: text.slice(start) };
}

export function excerpt(text: string, limit: number): { lines: string[]; hidden: number } {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return { lines: [], hidden: 0 };
  if (lines.length <= limit) return { lines, hidden: 0 };
  return { lines: lines.slice(0, limit), hidden: lines.length - limit };
}

function newToolBlock(call: ToolCall): ToolBlock {
  const { summary, diff } = describeCall(call);
  return { kind: "tool", id: call.id, name: call.name, summary, status: "running", output: [], hidden: 0, ...(diff ? { diff } : {}) };
}

function describeCall(call: ToolCall): { summary: string; diff?: string[] } {
  const args = isRecord(call.args) ? call.args : {};
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  if (call.name === "bash") return { summary: (str("command") ?? "").split("\n")[0]! + ((str("command") ?? "").includes("\n") ? " …" : "") };
  if (call.name === "read") return { summary: str("path") ?? "" };
  if (call.name === "write") return { summary: `${str("path") ?? ""} (${(str("content") ?? "").split("\n").length} lines)` };
  if (call.name === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [];
    const diff = edits.slice(0, 3).flatMap((edit) => [...String(edit.oldText ?? "").split("\n").slice(0, 4).map((line) => `- ${line}`), ...String(edit.newText ?? "").split("\n").slice(0, 4).map((line) => `+ ${line}`)]);
    return { summary: `${str("path") ?? ""} (${edits.length} edit${edits.length === 1 ? "" : "s"})`, diff };
  }
  const json = JSON.stringify(call.args ?? {});
  return { summary: json.length > 100 ? `${json.slice(0, 99)}…` : json };
}

/** Rebuilds blocks from a session log, so that a resumed session shows what was said before. */
export function replayLog(transcript: Transcript, entries: readonly LogEntry[]): void {
  const calls = new Map<string, ToolCall>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      transcript.apply({ type: "compaction", tokensBefore: entry.tokensBefore });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") transcript.apply({ type: "message_end", message });
    else if (message.role === "assistant") {
      transcript.apply({ type: "message_end", message });
      for (const part of message.content) if (part.type === "tool_call") calls.set(part.id, { id: part.id, name: part.name, args: part.args });
    } else if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId) ?? { id: message.toolCallId, name: message.toolName ?? "tool", args: {} };
      transcript.apply({ type: "tool_end", call, result: { content: message.content, ...(message.isError ? { isError: true } : {}) } });
    }
  }
}
