import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLineEditor, layoutText } from "../../src/tui/line-editor.ts";
import type { KeyEvent } from "../../src/tui/keys.ts";

const type = (editor: ReturnType<typeof createLineEditor>, text: string) => editor.handle({ name: "char", text });
const press = (editor: ReturnType<typeof createLineEditor>, ...keys: KeyEvent[]) => keys.map((key) => editor.handle(key));

describe("line editor", () => {
  it("inserts, moves and deletes at the cursor", () => {
    const editor = createLineEditor();
    type(editor, "helo");
    press(editor, { name: "left" });
    type(editor, "l");
    assert.equal(editor.value(), "hello");
    press(editor, { name: "backspace" });
    assert.equal(editor.value(), "helo");
    press(editor, { name: "delete" });
    assert.equal(editor.value(), "hel");
  });

  it("enter submits; shift/alt/ctrl-enter and backslash-enter insert a newline", () => {
    const editor = createLineEditor();
    type(editor, "a");
    assert.equal(editor.handle({ name: "enter", shift: true }), "none");
    type(editor, "b");
    assert.equal(editor.value(), "a\nb");
    type(editor, "\\");
    assert.equal(editor.handle({ name: "enter" }), "none");
    assert.equal(editor.value(), "a\nb\n");
    type(editor, "c");
    assert.equal(editor.handle({ name: "enter" }), "submit");
  });

  it("readline keys: ctrl-a/e/k/u/w/y", () => {
    const editor = createLineEditor();
    type(editor, "one two three");
    press(editor, { name: "w", ctrl: true });
    assert.equal(editor.value(), "one two ");
    press(editor, { name: "a", ctrl: true }, { name: "k", ctrl: true });
    assert.equal(editor.value(), "");
    press(editor, { name: "y", ctrl: true });
    assert.equal(editor.value(), "one two ");
    press(editor, { name: "u", ctrl: true });
    assert.equal(editor.value(), "");
  });

  it("moves by words", () => {
    const editor = createLineEditor();
    type(editor, "foo bar baz");
    press(editor, { name: "left", ctrl: true }, { name: "left", ctrl: true });
    assert.equal(editor.cursor(), 4);
    press(editor, { name: "right", ctrl: true });
    assert.equal(editor.cursor(), 7);
  });

  it("walks through history with up and down and restores the draft", () => {
    const editor = createLineEditor();
    editor.remember("first");
    editor.remember("second");
    type(editor, "draft");
    press(editor, { name: "up" });
    assert.equal(editor.value(), "second");
    press(editor, { name: "up" });
    assert.equal(editor.value(), "first");
    press(editor, { name: "down" }, { name: "down" });
    assert.equal(editor.value(), "draft");
  });

  it("up and down move between lines of a multi-line text before touching history", () => {
    const editor = createLineEditor();
    editor.remember("old");
    editor.set("ab\ncd");
    press(editor, { name: "up" });
    assert.equal(editor.value(), "ab\ncd");
    assert.equal(editor.cursor(), 2);
    press(editor, { name: "up" });
    assert.equal(editor.value(), "old");
  });

  it("reports interrupt, eof (only when empty), escape and tab", () => {
    const editor = createLineEditor();
    assert.equal(editor.handle({ name: "c", ctrl: true }), "interrupt");
    assert.equal(editor.handle({ name: "d", ctrl: true }), "eof");
    type(editor, "x");
    assert.equal(editor.handle({ name: "d", ctrl: true }), "none");
    assert.equal(editor.handle({ name: "escape" }), "escape");
    assert.equal(editor.handle({ name: "tab" }), "tab");
  });

  it("deletes a whole emoji or CJK character at once", () => {
    const editor = createLineEditor();
    type(editor, "a🙂");
    press(editor, { name: "backspace" });
    assert.equal(editor.value(), "a");
  });

  it("remembers lines without duplicates in a row and ignores blanks", () => {
    const editor = createLineEditor();
    editor.remember("x");
    editor.remember("x");
    editor.remember("  ");
    press(editor, { name: "up" }, { name: "up" });
    assert.equal(editor.value(), "x");
  });

  it("lays text out in rows and finds the cursor, also at a wrap and after a newline", () => {
    assert.deepEqual(layoutText("abcdef", 6, 4), { rows: ["abcd", "ef"], cursorRow: 1, cursorCol: 2 });
    assert.deepEqual(layoutText("ab\n", 3, 10), { rows: ["ab", ""], cursorRow: 1, cursorCol: 0 });
    assert.deepEqual(layoutText("你好a", 2, 4), { rows: ["你好", "a"], cursorRow: 1, cursorCol: 0 });
    assert.deepEqual(layoutText("", 0, 10), { rows: [""], cursorRow: 0, cursorCol: 0 });
  });
});
