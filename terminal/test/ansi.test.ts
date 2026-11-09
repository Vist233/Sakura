import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPalette, displayWidth, padEnd, stripAnsi, truncate, wrapAnsi } from "../src/ansi.ts";

describe("ansi", () => {
  const color = createPalette(true);
  const plain = createPalette(false);

  it("styles only when enabled", () => {
    assert.equal(plain.bold("x"), "x");
    assert.equal(stripAnsi(color.bold("x")), "x");
    assert.notEqual(color.red("x"), "x");
  });

  it("measures display width: escapes are free, CJK and emoji take two columns", () => {
    assert.equal(displayWidth(color.red("abc")), 3);
    assert.equal(displayWidth("你好"), 4);
    assert.equal(displayWidth("a🙂"), 3);
    assert.equal(displayWidth("é"), 1);
  });

  it("wraps at spaces", () => {
    assert.deepEqual(wrapAnsi("one two three four", 9), ["one two", "three", "four"]);
  });

  it("breaks a word that is longer than the line", () => {
    assert.deepEqual(wrapAnsi("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  });

  it("wraps CJK text by columns", () => {
    const lines = wrapAnsi("你好世界你好", 6);
    assert.deepEqual(lines, ["你好世", "界你好"]);
  });

  it("keeps a style across a line break", () => {
    const lines = wrapAnsi(color.bold("aaa bbb"), 3);
    assert.equal(lines.length, 2);
    assert.equal(stripAnsi(lines[1]!), "bbb");
    assert.ok(lines[1]!.startsWith("\u001b[1m"), "second line reopens the style");
    assert.ok(lines[0]!.endsWith("\u001b[0m"), "first line closes the style");
  });

  it("keeps newlines and empty lines", () => {
    assert.deepEqual(wrapAnsi("a\n\nb", 10), ["a", "", "b"]);
  });

  it("truncates with an ellipsis", () => {
    assert.equal(stripAnsi(truncate("abcdefgh", 5)), "abcd…");
    assert.equal(truncate("abc", 5), "abc");
  });

  it("pads to a display width", () => {
    assert.equal(padEnd("你", 4), "你  ");
  });
});
