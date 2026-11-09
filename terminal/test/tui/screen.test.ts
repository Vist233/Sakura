import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, stripAnsi } from "../../src/ansi.ts";
import { layoutText } from "../../src/tui/line-editor.ts";
import { composeLive } from "../../src/tui/screen.ts";
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
