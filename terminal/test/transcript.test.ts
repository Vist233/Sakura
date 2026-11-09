import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event, LogEntry, Message } from "../src/framework.ts";
import { createTranscript, excerpt, INTERRUPTED_NOTE, MENTION_NOTE, replayLog, splitCommittable } from "../src/transcript.ts";

const assistant = (text: string, extra: Partial<Message> = {}): Message => ({ role: "assistant", content: [{ type: "text", text }], ts: 0, ...extra });
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], ts: 0 });
const feed = (events: Event[]) => {
  const transcript = createTranscript();
  for (const event of events) transcript.apply(event);
  return transcript;
};
const textDelta = (text: string): Event => ({ type: "message_update", delta: { type: "text", text } });

describe("transcript", () => {
  it("splits streamed text into finished blocks and keeps the open tail", () => {
    assert.deepEqual(splitCommittable("para one\n\npara two\n\ntai"), { done: ["para one\n\n", "para two\n\n"], rest: "tai" });
    assert.deepEqual(splitCommittable("no blank yet\nstill"), { done: [], rest: "no blank yet\nstill" });
  });

  it("does not split inside a code fence", () => {
    const text = "intro\n\n```js\na\n\nb\n```\n\nafter";
    const { done, rest } = splitCommittable(text);
    assert.deepEqual(done, ["intro\n\n", "```js\na\n\nb\n```\n\n"]);
    assert.equal(rest, "after");
  });

  it("commits assistant text block by block while streaming, and the rest at the end", () => {
    const transcript = createTranscript();
    const seen: string[] = [];
    transcript.subscribe((change) => change.type === "commit" && change.block.kind === "assistant" && seen.push(change.block.text));
    transcript.apply({ type: "run_start" });
    transcript.apply(textDelta("First para.\n\nSec"));
    assert.deepEqual(seen, ["First para.\n\n"]);
    assert.equal(transcript.state().pending, "Sec");
    transcript.apply(textDelta("ond."));
    transcript.apply({ type: "message_end", message: assistant("First para.\n\nSecond.") });
    assert.deepEqual(seen, ["First para.\n\n", "Second."]);
    const blocks = transcript.blocks();
    assert.deepEqual(blocks.map((block) => block.kind === "assistant" && block.first), [true, false]);
  });

  it("shows text that was never streamed", () => {
    const transcript = feed([{ type: "run_start" }, { type: "message_end", message: assistant("whole") }]);
    assert.deepEqual(transcript.blocks(), [{ kind: "assistant", text: "whole", first: true }]);
  });

  it("restarts after a dropped connection with a notice", () => {
    const transcript = feed([{ type: "run_start" }, textDelta("A\n\nB"), { type: "message_reset" }, textDelta("again"), { type: "message_end", message: assistant("again") }]);
    assert.deepEqual(transcript.blocks().map((block) => block.kind), ["assistant", "notice", "assistant"]);
  });

  it("does not show the note added for the model (@paths)", () => {
    const shown = feed([{ type: "message_end", message: user(`look at @a.txt${MENTION_NOTE}- /w/a.txt`) }]).blocks();
    assert.deepEqual(shown, [{ kind: "user", text: "look at @a.txt" }]);
  });

  it("shows a slash command's canned prompt as the command name", () => {
    assert.deepEqual(feed([{ type: "message_end", message: user("[/init] Create an AGENTS.md file ...") }]).blocks(), [{ kind: "user", text: "/init" }]);
  });

  it("matches a review decision to its call by id, not by tool name", () => {
    const first = { id: "a", name: "bash", args: { command: "one" } };
    const second = { id: "b", name: "bash", args: { command: "two" } };
    const transcript = feed([
      { type: "plugin", name: "review", data: { kind: "review", tool: "bash", callId: "a", outcome: "deny", decidedBy: "reviewer", reason: "no" } },
      { type: "plugin", name: "review", data: { kind: "review", tool: "bash", callId: "b", outcome: "allow", decidedBy: "reviewer", reason: "ok" } },
      { type: "tool_start", call: second },
      { type: "tool_end", call: second, result: { content: [{ type: "text", text: "fine" }] } },
      { type: "tool_end", call: first, result: { isError: true, content: [{ type: "text", text: "Not allowed: no" }] } },
    ]);
    const [done, refused] = transcript.blocks();
    assert.ok(done?.kind === "tool" && refused?.kind === "tool");
    assert.equal(done.review?.outcome, "allow");
    assert.equal(refused.status, "denied");
    assert.equal(refused.review?.reason, "no");
  });

  it("hides the kernel's interrupted marker and shows reasoning only in the live state", () => {
    const transcript = feed([{ type: "run_start" }, { type: "reasoning_update", delta: "let me think" }]);
    assert.equal(transcript.state().reasoning, "let me think");
    transcript.apply({ type: "message_end", message: assistant(INTERRUPTED_NOTE) });
    assert.equal(transcript.state().reasoning, "");
    assert.deepEqual(transcript.blocks(), []);
  });

  it("records user messages", () => {
    assert.deepEqual(feed([{ type: "message_end", message: user("hi") }]).blocks(), [{ kind: "user", text: "hi" }]);
  });

  it("tracks a tool call from start to end", () => {
    const call = { id: "1", name: "bash", args: { command: "ls -la\necho" } };
    const transcript = feed([{ type: "tool_start", call }]);
    assert.equal(transcript.state().running[0]?.summary, "ls -la …");
    transcript.apply({ type: "tool_end", call, result: { content: [{ type: "text", text: "a\nb" }] } });
    assert.equal(transcript.state().running.length, 0);
    const block = transcript.blocks()[0]!;
    assert.ok(block.kind === "tool");
    assert.equal(block.status, "ok");
    assert.deepEqual(block.output, ["a", "b"]);
  });

  it("shows a failed command as failed, with its real exit code", () => {
    const call = { id: "1", name: "bash", args: { command: "false" } };
    const transcript = feed([
      { type: "tool_start", call },
      { type: "tool_end", call, result: { isError: true, content: [{ type: "text", text: "boom\n\nCommand exited with code 3." }] } },
    ]);
    const block = transcript.blocks()[0]!;
    assert.ok(block.kind === "tool");
    assert.equal(block.status, "error");
    assert.equal(block.exitCode, 3);
  });

  it("marks a call the review refused as denied, with the reviewer's reason", () => {
    const call = { id: "9", name: "bash", args: { command: "rm -rf /" } };
    const transcript = feed([
      { type: "plugin", name: "review", data: { kind: "review", tool: "bash", callId: "9", outcome: "deny", decidedBy: "hard-rules", reason: "deletes everything" } },
      { type: "tool_end", call, result: { isError: true, content: [{ type: "text", text: "Not allowed: deletes everything Do not try again." }] } },
    ]);
    const block = transcript.blocks()[0]!;
    assert.ok(block.kind === "tool");
    assert.equal(block.status, "denied");
    assert.equal(block.review?.decidedBy, "hard-rules");
  });

  it("attaches an allowing review to the tool that follows", () => {
    const call = { id: "9", name: "write", args: { path: "a.txt", content: "x\ny" } };
    const transcript = feed([
      { type: "plugin", name: "review", data: { kind: "review", tool: "write", callId: "9", outcome: "allow", decidedBy: "reviewer", reason: "ok" } },
      { type: "tool_start", call },
      { type: "tool_end", call, result: { content: [{ type: "text", text: "Wrote a.txt" }] } },
    ]);
    const block = transcript.blocks()[0]!;
    assert.ok(block.kind === "tool");
    assert.equal(block.summary, "a.txt (2 lines)");
    assert.equal(block.review?.outcome, "allow");
  });

  it("describes edits with a small diff", () => {
    const call = { id: "e", name: "edit", args: { path: "f.ts", edits: [{ oldText: "a", newText: "b\nc" }] } };
    const transcript = feed([{ type: "tool_start", call }]);
    assert.deepEqual(transcript.state().running[0]?.diff, ["- a", "+ b", "+ c"]);
  });

  it("limits long output and says how much was left out", () => {
    assert.deepEqual(excerpt("1\n2\n3\n4", 2), { lines: ["1", "2"], hidden: 2 });
    assert.deepEqual(excerpt("", 2), { lines: [], hidden: 0 });
  });

  it("notes cancellation, pauses, compaction and cut-off replies", () => {
    const transcript = feed([{ type: "run_start" }, { type: "compaction", tokensBefore: 5 }, { type: "paused", reason: "approval" }, { type: "message_end", message: assistant("x", { stop: "length" }) }, { type: "run_end", reason: "cancelled" }]);
    assert.deepEqual(transcript.blocks().map((block) => block.kind), ["compaction", "notice", "assistant", "notice", "notice"]);
    assert.equal(transcript.state().working, false);
  });

  it("rebuilds the blocks of a session from its log", () => {
    const entry = (id: string, message: Message): LogEntry => ({ type: "message", message, id, parentId: null, ts: 0 });
    const transcript = createTranscript();
    replayLog(transcript, [
      entry("1", user("do it")),
      entry("2", { role: "assistant", ts: 0, content: [{ type: "text", text: "Running." }, { type: "tool_call", id: "c1", name: "bash", args: { command: "echo hi" } }] }),
      entry("3", { role: "tool", ts: 0, toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "hi" }] }),
      entry("4", assistant("Done.")),
    ]);
    assert.deepEqual(transcript.blocks().map((block) => block.kind), ["user", "assistant", "tool", "assistant"]);
  });

  it("reset clears the blocks", () => {
    const transcript = feed([{ type: "message_end", message: user("x") }]);
    transcript.reset();
    assert.deepEqual(transcript.blocks(), []);
  });
});
