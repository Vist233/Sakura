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

describe("pasted text", () => {
  const paste = (editor: ReturnType<typeof createLineEditor>, text: string) => editor.handle({ name: "paste", text });
  const big = (label: string, count: number) => `${label}${"x".repeat(count - label.length)}`;

  it("keeps a short paste as it is", () => {
    const editor = createLineEditor();
    paste(editor, "one\ntwo");
    assert.equal(editor.value(), "one\ntwo");
  });

  it("shows a long paste as a placeholder in Codex's wording and sends the full text", () => {
    const editor = createLineEditor();
    const text = big("start", 1200);
    type(editor, "see ");
    paste(editor, text);
    type(editor, " please");
    assert.equal(editor.value(), "see [Pasted Content 1200 chars] please");
    assert.equal(editor.expanded(), `see ${text} please`);
  });

  it("folds a paste of many lines even when it is short", () => {
    const editor = createLineEditor();
    paste(editor, "a\nb\nc\nd\ne\nf\ng");
    assert.match(editor.value(), /^\[Pasted Content 13 chars\]$/);
    assert.equal(editor.expanded(), "a\nb\nc\nd\ne\nf\ng");
  });

  it("numbers pastes of the same size and keeps several in one message", () => {
    const editor = createLineEditor();
    const first = big("a", 1100);
    const second = big("b", 1100);
    paste(editor, first);
    type(editor, " and ");
    paste(editor, second);
    assert.equal(editor.value(), "[Pasted Content 1100 chars] and [Pasted Content 1100 chars #2]");
    assert.equal(editor.expanded(), `${first} and ${second}`);
  });

  it("treats a placeholder as one unit: Backspace and Delete remove it whole, arrows jump over it", () => {
    const editor = createLineEditor();
    type(editor, "x");
    paste(editor, big("p", 1500));
    type(editor, "y");
    press(editor, { name: "left" }, { name: "left" });
    assert.equal(editor.cursor(), 1, "left twice passes y, then the whole placeholder");
    press(editor, { name: "right" });
    assert.equal(editor.cursor(), 1 + "[Pasted Content 1500 chars]".length);
    press(editor, { name: "backspace" });
    assert.equal(editor.value(), "xy");
    assert.equal(editor.expanded(), "xy");
    paste(editor, big("q", 1500));
    press(editor, { name: "left" }, { name: "delete" });
    assert.equal(editor.value(), "xy");
  });

  it("recalls a sent message with its real text", () => {
    const editor = createLineEditor();
    const text = big("z", 2000);
    paste(editor, text);
    const shown = editor.value();
    editor.remember(shown);
    editor.clear();
    assert.equal(editor.value(), "");
    press(editor, { name: "up" });
    assert.equal(editor.value(), shown);
    assert.equal(editor.expanded(), text);
  });

  it("folds text that is set from outside (the previous message after /undo) when it is long", () => {
    const editor = createLineEditor();
    editor.set(big("w", 1300));
    assert.equal(editor.value(), "[Pasted Content 1300 chars]");
    editor.set("short");
    assert.equal(editor.value(), "short");
    assert.equal(editor.expanded(), "short");
  });
});
