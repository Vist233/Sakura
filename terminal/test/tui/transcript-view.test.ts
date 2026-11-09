import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, stripAnsi } from "../../src/ansi.ts";
import { relativize, renderBlock, spacingBetween } from "../../src/tui/transcript-view.ts";
import type { ToolBlock } from "../../src/transcript.ts";

const plain = (block: Parameters<typeof renderBlock>[0], width = 60) => renderBlock(block, { width, color: false });
const tool = (extra: Partial<ToolBlock>): ToolBlock => ({ kind: "tool", id: "1", name: "bash", summary: "ls", status: "ok", output: [], hidden: 0, ...extra });

describe("transcript view", () => {
  it("shows user messages with a prompt mark and hanging indent", () => {
    assert.deepEqual(plain({ kind: "user", text: "line one\nline two" }), ["› line one", "  line two"]);
  });

  it("cuts a long user message to ten rows with a count of the rest", () => {
    const text = Array.from({ length: 25 }, (_, index) => `row ${index}`).join("\n");
    const rows = plain({ kind: "user", text });
    assert.equal(rows.length, 11);
    assert.equal(rows[0], "› row 0");
    assert.equal(rows[10], "  … +15 lines");
  });

  it("renders assistant Markdown and marks only the first block of a reply", () => {
    assert.deepEqual(plain({ kind: "assistant", text: "# Title\n\n- a\n- b", first: true }), ["• Title", "", "  • a", "  • b"]);
    assert.equal(plain({ kind: "assistant", text: "more", first: false })[0], "  more");
  });

  it("shows a successful tool call with its output", () => {
    assert.deepEqual(plain(tool({ output: ["a", "b"], hidden: 3 })), ["✓ bash ls", "  │ a", "  │ b", "  │ … +3 lines"]);
  });

  it("shows a failed command as failed with its exit code", () => {
    const [head] = plain(tool({ status: "error", exitCode: 3, summary: "false" }));
    assert.equal(head, "✗ bash false (exit 3)");
  });

  it("shows a refused call with the reviewer and its reason, without output", () => {
    const lines = plain(tool({ status: "denied", summary: "rm -rf /", output: ["Not allowed"], review: { outcome: "deny", decidedBy: "hard-rules", reason: "deletes everything" } }));
    assert.deepEqual(lines, ["⊘ bash rm -rf / denied by review (hard-rules)", "  deletes everything"]);
  });

  it("shows edits as a coloured diff", () => {
    const lines = renderBlock(tool({ name: "edit", summary: "f.ts (1 edit)", diff: ["- a", "+ b"] }), { width: 60, color: true });
    assert.ok(lines[1]!.includes("\u001b[31m"));
    assert.ok(lines[2]!.includes("\u001b[32m"));
  });

  it("shows notices, compaction and shell output", () => {
    assert.deepEqual(plain({ kind: "notice", level: "error", text: "bad" }), ["✗ bad"]);
    assert.match(plain({ kind: "compaction", tokensBefore: 12345 })[0]!, /12,345 tokens/);
    assert.deepEqual(plain({ kind: "shell", command: "false", output: ["x"], hidden: 0, exitCode: 1 }), ["$ false", "  x", "  exit code 1"]);
    assert.deepEqual(plain({ kind: "shell", command: "true", output: [], hidden: 0, exitCode: 0 }), ["$ true"]);
  });

  it("never exceeds the width", () => {
    const long = "word ".repeat(50);
    for (const block of [{ kind: "user", text: long }, { kind: "assistant", text: long, first: true }, { kind: "notice", level: "info", text: long }] as const)
      for (const line of renderBlock(block, { width: 30, color: true })) assert.ok(displayWidth(stripAnsi(line)) <= 30);
  });

  it("spaces blocks with a blank line except tool after tool", () => {
    assert.equal(spacingBetween(undefined, { kind: "user", text: "x" }), 0);
    assert.equal(spacingBetween(tool({}), tool({})), 0);
    assert.equal(spacingBetween({ kind: "user", text: "x" }, tool({})), 1);
  });

  it("shows paths under the launch directory relative to it", () => {
    assert.equal(relativize("write /work/proj/src/a.py ok", "/work/proj"), "write src/a.py ok");
    assert.equal(relativize("cd /work/proj && ls", "/work/proj"), "cd . && ls");
    assert.equal(relativize("/work/project2/x", "/work/proj"), "/work/project2/x");
    assert.equal(relativize("/etc/hosts", "/work/proj"), "/etc/hosts");
    assert.equal(relativize("anything", undefined), "anything");
    const [head] = renderBlock(tool({ summary: "/work/proj/a.py (3 lines)" }), { width: 60, color: false, cwd: "/work/proj" });
    assert.equal(head, "✓ bash a.py (3 lines)");
  });
});
