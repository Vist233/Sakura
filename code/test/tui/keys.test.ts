import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeyDecoder } from "../../src/tui/keys.ts";

const decode = (...chunks: string[]) => {
  const decoder = createKeyDecoder();
  return chunks.flatMap((chunk) => decoder.push(chunk));
};

describe("keys", () => {
  it("groups printable text and names control keys", () => {
    assert.deepEqual(decode("hi 你好\r"), [{ name: "char", text: "hi 你好" }, { name: "enter" }]);
    assert.deepEqual(decode("\u0003"), [{ name: "c", ctrl: true }]);
    assert.deepEqual(decode("\t\u007f"), [{ name: "tab" }, { name: "backspace" }]);
  });

  it("decodes arrows, home, end, delete and Shift-Tab", () => {
    assert.deepEqual(decode("\u001b[A\u001b[B\u001b[C\u001b[D"), [{ name: "up" }, { name: "down" }, { name: "right" }, { name: "left" }]);
    assert.deepEqual(decode("\u001b[H\u001b[F\u001b[3~\u001b[Z"), [{ name: "home" }, { name: "end" }, { name: "delete" }, { name: "tab", shift: true }]);
    assert.deepEqual(decode("\u001bOA"), [{ name: "up" }]);
  });

  it("decodes modified arrows", () => {
    assert.deepEqual(decode("\u001b[1;5C"), [{ name: "right", ctrl: true }]);
    assert.deepEqual(decode("\u001b[1;3D"), [{ name: "left", alt: true }]);
  });

  it("decodes the Shift-Enter encodings", () => {
    assert.deepEqual(decode("\u001b[13;2u"), [{ name: "enter", shift: true }]);
    assert.deepEqual(decode("\u001b[27;2;13~"), [{ name: "enter", shift: true }]);
    assert.deepEqual(decode("\u001b\r"), [{ name: "enter", alt: true }]);
    assert.deepEqual(decode("\n"), [{ name: "enter", ctrl: true }]);
  });

  it("decodes Alt+letter and a lone Escape", () => {
    assert.deepEqual(decode("\u001bb"), [{ name: "char", text: "b", alt: true }]);
    assert.deepEqual(decode("\u001b"), [{ name: "escape" }]);
  });

  it("collects a bracketed paste, also across chunks, and keeps newlines", () => {
    assert.deepEqual(decode("a\u001b[200~line1\r\nline", "2\u001b[201~b"), [{ name: "char", text: "a" }, { name: "paste", text: "line1\nline2" }, { name: "char", text: "b" }]);
  });

  it("waits for the rest of a split escape sequence", () => {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.push("\u001b[1;"), []);
    assert.deepEqual(decoder.push("5D"), [{ name: "left", ctrl: true }]);
  });
});
