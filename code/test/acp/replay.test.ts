import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replayUpdates } from "../../src/acp/replay.ts";
import type { LogEntry } from "../../src/framework.ts";

let n = 0;
const entry = (message: object): LogEntry => ({ id: `e${++n}`, parentId: null, ts: 0, type: "message", message: { ts: 0, ...message } } as LogEntry);

describe("replay (L1)", () => {
  it("rebuilds user text, assistant text and tool cards in order, with the entry ids as message ids", () => {
    const log = [
      entry({ role: "user", content: [{ type: "text", text: "list files" }] }),
      entry({ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "t1", name: "bash", args: { command: "ls" } }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      entry({ role: "tool", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] }),
      entry({ role: "assistant", content: [{ type: "text", text: "One file." }] }),
    ];
    const updates = replayUpdates(log, { cwd: "/w" });
    assert.deepEqual(updates.map((update) => update.sessionUpdate), ["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "agent_message_chunk"]);
    assert.deepEqual(updates.filter((update) => "messageId" in update).map((update) => (update as { messageId: string }).messageId), [log[0]!.id, log[1]!.id, log[3]!.id]);
    assert.equal((updates[3] as { status: string }).status, "completed");
    assert.ok(!updates.some((update) => update.sessionUpdate === "usage_update"), "no meter in a replay");
  });

  it("is the same every time", () => {
    const log = [entry({ role: "user", content: [{ type: "text", text: "hi" }] }), entry({ role: "assistant", content: [{ type: "text", text: "yo" }] })];
    assert.deepEqual(replayUpdates(log, { cwd: "/w" }), replayUpdates(log, { cwd: "/w" }));
  });

  it("failed tools, images and unrelated entries do not break it", () => {
    const log = [
      entry({ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mediaType: "image/png", ref: "/x.png" }] }),
      entry({ role: "assistant", content: [{ type: "tool_call", id: "t2", name: "edit", args: { path: "a", edits: [{ oldText: "x", newText: "y" }] } }] }),
      entry({ role: "tool", toolCallId: "t2", toolName: "edit", isError: true, content: [{ type: "text", text: "no match" }] }),
      entry({ role: "tool", toolCallId: "orphan", content: [{ type: "text", text: "late" }] }),
      { id: "c", parentId: null, ts: 0, type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 5 } as LogEntry,
      entry({ role: "system", content: [{ type: "text", text: "sys" }] }),
    ];
    const updates = replayUpdates(log, { cwd: "/w" });
    assert.match(JSON.stringify(updates[0]), /see\\n\\n\[image\]/);
    assert.equal((updates.find((update) => update.sessionUpdate === "tool_call_update") as { status: string }).status, "failed");
  });

  it("an empty log gives nothing", () => assert.deepEqual(replayUpdates([], { cwd: "/w" }), []));
});
