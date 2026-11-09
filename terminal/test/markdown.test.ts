import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, stripAnsi } from "../src/ansi.ts";
import { renderMarkdown } from "../src/markdown.ts";

const plain = (text: string, width = 60) => renderMarkdown(text, { width, color: false });

describe("markdown", () => {
  it("renders headings, paragraphs and separates blocks with one blank line", () => {
    assert.deepEqual(plain("# Title\n\nSome text\nmore text\n\n## Sub\nbody"), ["Title", "", "Some text more text", "", "Sub", "", "body"]);
  });

  it("styles headings, bold, italic and inline code when colour is on", () => {
    const [heading, , line] = renderMarkdown("# Hi\n\n**b** *i* `c` ~~s~~", { width: 40, color: true });
    assert.ok(heading!.includes("\u001b[1m"));
    assert.equal(stripAnsi(line!), "b i c s");
    assert.ok(line!.includes("\u001b[1mb"));
    assert.ok(line!.includes("\u001b[3mi"));
    assert.ok(line!.includes("\u001b[36mc"));
    assert.ok(line!.includes("\u001b[9ms"));
  });

  it("does not treat snake_case or a lone star as emphasis", () => {
    assert.deepEqual(plain("use snake_case_name and 2 * 3 * 4"), ["use snake_case_name and 2 * 3 * 4"]);
  });

  it("keeps markers inside inline code", () => {
    assert.deepEqual(plain("run `a **b** c` now"), ["run a **b** c now"]);
  });

  it("renders bullet and ordered lists with hanging indent", () => {
    const lines = plain("- first item that is rather long and wraps around\n- second\n\n1. one\n2. two", 24);
    assert.deepEqual(lines, ["• first item that is", "  rather long and wraps", "  around", "• second", "", "1. one", "2. two"]);
  });

  it("renders nested lists and task lists", () => {
    assert.deepEqual(plain("- a\n  - b\n  - c\n- d"), ["• a", "  • b", "  • c", "• d"]);
    assert.deepEqual(plain("- [ ] todo\n- [x] done"), ["☐ todo", "☑ done"]);
  });

  it("renders fenced code verbatim, with the language", () => {
    const lines = plain("text\n\n```ts\nconst a = `x`;\n  indented\n```\n\nafter");
    assert.equal(lines[0], "text");
    assert.equal(lines[2], "  ts");
    assert.equal(lines[3], "  const a = `x`;");
    assert.equal(lines[4], "    indented");
    assert.equal(lines.at(-1), "after");
  });

  it("closes an unterminated fence at the end of the text", () => {
    const lines = plain("```\nopen");
    assert.ok(lines.includes("  open"));
  });

  it("renders block quotes", () => {
    assert.deepEqual(plain("> quoted\n> text"), ["│ quoted text"]);
  });

  it("renders links as text and url, and bare urls", () => {
    assert.deepEqual(plain("see [docs](https://a.dev/x) and https://b.dev."), ["see docs (https://a.dev/x) and https://b.dev."]);
  });

  it("renders tables with borders and alignment", () => {
    const lines = plain("| name | n |\n|:--|--:|\n| a | 10 |\n| bb | 2 |");
    assert.deepEqual(lines, ["┌──────┬────┐", "│ name │  n │", "├──────┼────┤", "│ a    │ 10 │", "│ bb   │  2 │", "└──────┴────┘"]);
  });

  it("keeps a wide table inside the width by wrapping cells", () => {
    const lines = plain("| key | description |\n|---|---|\n| a | " + "word ".repeat(30) + " |", 40);
    for (const line of lines) assert.ok(displayWidth(line) <= 40, `${line} is ${displayWidth(line)} wide`);
    assert.ok(lines.length > 6);
  });

  it("keeps table rows the same width when colours are on", () => {
    const lines = renderMarkdown("| name | n |\n|:--|--:|\n| a | 10 |\n| bb | 2 |", { width: 60, color: true });
    assert.equal(new Set(lines.map(displayWidth)).size, 1);
  });

  it("aligns tables with CJK text", () => {
    const lines = plain("| 名称 | 值 |\n|--|--|\n| 苹果 | 1 |");
    const widths = new Set(lines.map(displayWidth));
    assert.equal(widths.size, 1);
  });

  it("renders a rule and escapes", () => {
    assert.equal(plain("---")[0]!.startsWith("─"), true);
    assert.deepEqual(plain("\\*not italic\\*"), ["*not italic*"]);
  });

  it("wraps long paragraphs to the width", () => {
    const lines = plain("word ".repeat(20).trim(), 20);
    for (const line of lines) assert.ok(displayWidth(line) <= 20);
  });

  it("handles empty input", () => {
    assert.deepEqual(plain(""), []);
  });
});
