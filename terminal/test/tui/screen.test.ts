import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, stripAnsi } from "../../src/ansi.ts";
import { layoutText } from "../../src/tui/line-editor.ts";
import { composeLive, composerWindow } from "../../src/tui/screen.ts";
import type { ScreenState } from "../../src/tui/screen.ts";
import { COMMANDS } from "../../src/slash-commands.ts";

const base = (extra: Partial<ScreenState> = {}): ScreenState => ({
  width: 50,
  color: false,
  composer: layoutText("hello", 5, 40),
  statusLine: "model · 90% context left · ~/p",
  working: false,
  elapsedSeconds: 0,
  frame: 0,
  runningTools: [],
  streamingTail: "",
  reasoning: "",
  pending: [],
  popup: undefined,
  picker: undefined,
  hint: undefined,
  ...extra,
});

describe("screen", () => {
  it("idle: rule, prompt, status line; cursor after the text", () => {
    const view = composeLive(base());
    assert.deepEqual(view.lines.map((line) => line.replace(/─+/, "─")), ["─", "› hello", " model · 90% context left · ~/p"]);
    assert.deepEqual(view.cursor, { row: 1, col: 7 });
  });

  it("working: shows progress, the running tool and queued messages above the prompt", () => {
    const view = composeLive(
      base({
        working: true,
        elapsedSeconds: 12,
        runningTools: [{ kind: "tool", id: "1", name: "bash", summary: "npm test", status: "running", output: [], hidden: 0 }],
        pending: [{ kind: "queue", text: "then do this" }],
        streamingTail: "partial text of the reply",
      }),
    );
    const text = view.lines.map(stripAnsi).join("\n");
    assert.match(text, /partial text of the reply/);
    assert.match(text, /⠋ bash npm test/);
    assert.match(text, /Working \(12s\) · Esc to cancel/);
    assert.match(text, /↳ queued: then do this/);
    assert.equal(stripAnsi(view.lines[view.cursor.row]!).startsWith("› hello"), true);
  });

  it("shows the end of the reasoning text on one line while the model thinks", () => {
    const view = composeLive(base({ working: true, reasoning: `first part\n${"x".repeat(300)} last words` }));
    const line = view.lines.map(stripAnsi).find((text) => text.includes("thinking:"))!;
    assert.match(line, /thinking: …/);
    assert.ok(line.includes("last words") && !line.includes("first part"));
    assert.ok(displayWidth(line) <= 50);
  });

  it("multi-line prompt: cursor follows the right row", () => {
    const view = composeLive(base({ composer: layoutText("ab\ncd", 4, 40) }));
    assert.equal(stripAnsi(view.lines[view.cursor.row]!), "  cd");
    assert.equal(view.cursor.col, 3);
  });

  it("slash popup lists commands under the status line", () => {
    const view = composeLive(base({ popup: { commands: COMMANDS.slice(0, 3), index: 1 } }));
    const tail = view.lines.slice(-3).map(stripAnsi);
    assert.match(tail[0]!, /^ {2}\/help/);
    assert.match(tail[1]!, /^› \/status/);
  });

  it("picker replaces the prompt", () => {
    const view = composeLive(
      base({
        picker: {
          title: "Resume",
          index: 0,
          items: [{ id: "abcdef1234", cwd: "/", provider: "p", model: "m", title: "fix bug", createdAt: 0, updatedAt: 0 }],
        },
      }),
    );
    const text = view.lines.map(stripAnsi).join("\n");
    assert.match(text, /Resume/);
    assert.match(text, /› 1970-01-01 00:00 {2}abcdef12 {2}fix bug/);
    assert.ok(!text.includes("context left"));
  });

  it("every line fits the width", () => {
    const view = composeLive(base({ width: 30, working: true, streamingTail: "x".repeat(100), statusLine: "y".repeat(100), pending: [{ kind: "steer", text: "z".repeat(100) }] }));
    for (const line of view.lines) assert.ok(displayWidth(line) <= 30, `${displayWidth(line)}: ${line}`);
  });
});

describe("composer window", () => {
  it("keeps every row when they fit", () => {
    const rows = ["a", "b", "c"];
    assert.deepEqual(composerWindow({ rows, cursorRow: 2, cursorCol: 1 }, 5), { rows, above: 0, below: 0, cursorRow: 2 });
  });

  it("shows the rows around the cursor with the number of hidden rows on each side", () => {
    const rows = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const window = composerWindow({ rows, cursorRow: 10, cursorCol: 0 }, 6);
    assert.equal(window.rows.length, 4);
    assert.ok(window.rows.includes("line 10"));
    assert.equal(window.above + window.rows.length + window.below, 20);
    assert.equal(window.rows[window.cursorRow], "line 10");
    const top = composerWindow({ rows, cursorRow: 0, cursorCol: 0 }, 6);
    assert.deepEqual([top.above, top.below], [0, 16]);
  });

  it("composeLive limits the height, marks the hidden lines and keeps the cursor on its row", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `row ${index}`);
    const view = composeLive({ ...base(), composer: { rows, cursorRow: 29, cursorCol: 3 }, maxComposerRows: 8 });
    const text = view.lines.join("\n");
    assert.match(text, /… \+24 lines/);
    assert.ok(view.lines.length <= 1 + 8 + 1);
    assert.match(view.lines[view.cursor.row]!, /row 29/);
  });
});
