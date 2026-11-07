import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { applyEdits, detectLineEnding, normalizeForFuzzyMatch, normalizeToLF, restoreLineEndings, splitBom } from "../src/edit-match.ts";
import { editTool } from "../src/builtin/edit.ts";
import { decode, range, run, useSandbox } from "./helpers.ts";

const box = useSandbox();

function randomFile(seed: number, lines: number): string[] {
  const rng = createRng(seed);
  return Array.from({ length: lines }, (_, index) => `line_${index}_${rng.int(1000, 9999)} value = ${rng.int(0, 99)};`);
}

describe("applyEdits: exact matches against an independent expectation", () => {
  for (const seed of range(60)) {
    it(`replaces disjoint unique lines (seed ${seed})`, () => {
      const rng = createRng(seed);
      const lines = randomFile(seed, rng.int(3, 40));
      const chosen = [...new Set(Array.from({ length: rng.int(1, Math.min(5, lines.length)) }, () => rng.int(0, lines.length - 1)))];
      const edits = chosen.map((index) => ({ oldText: lines[index] as string, newText: `CHANGED ${index}` }));
      const expected = lines.map((line, index) => (chosen.includes(index) ? `CHANGED ${index}` : line));
      const shuffled = [...edits].sort(() => rng.next() - 0.5);
      expect(applyEdits(lines.join("\n"), shuffled, "f.txt").split("\n")).toEqual(expected);
    });
  }

  for (const seed of range(20, 100)) {
    it(`replaces a fragment inside a line and leaves the rest (seed ${seed})`, () => {
      const lines = randomFile(seed, 6);
      const target = seed % 6;
      const fragment = `value = ${(lines[target] as string).match(/value = (\d+)/)?.[1]}`;
      const result = applyEdits(lines.join("\n"), [{ oldText: `line_${target}_`, newText: "renamed_" }], "f");
      expect(result).toContain(`renamed_${(lines[target] as string).slice(`line_${target}_`.length)}`);
      expect(fragment.length).toBeGreaterThan(0);
      expect(result.split("\n")).toHaveLength(6);
    });
  }

  it("a multi-line oldText matches across lines", () => {
    expect(applyEdits("a\nb\nc\nd", [{ oldText: "b\nc", newText: "X" }], "f")).toBe("a\nX\nd");
  });
  it("can delete text with an empty newText", () => {
    expect(applyEdits("keep\nremove\nkeep", [{ oldText: "remove\n", newText: "" }], "f")).toBe("keep\nkeep");
  });
  it("edits are matched against the original, not after earlier edits", () => {
    expect(
      applyEdits(
        "one two",
        [
          { oldText: "one", newText: "two" },
          { oldText: "two", newText: "three" },
        ],
        "f",
      ),
    ).toBe("two three");
  });
  it("normalises CRLF in oldText and newText", () => {
    expect(applyEdits("a\nb\nc", [{ oldText: "a\r\nb", newText: "x\r\ny" }], "f")).toBe("x\ny\nc");
  });
});

describe("applyEdits: errors", () => {
  const content = "alpha\nbeta\nbeta\ngamma";
  it("reports text that is not found (single edit)", () => {
    expect(() => applyEdits(content, [{ oldText: "delta", newText: "x" }], "f.txt")).toThrow("Could not find the exact text in f.txt");
  });
  it("names the edit that is not found (several edits)", () => {
    expect(() =>
      applyEdits(
        content,
        [
          { oldText: "alpha", newText: "x" },
          { oldText: "delta", newText: "y" },
        ],
        "f",
      ),
    ).toThrow("edits[1]");
  });
  for (const count of [2, 3, 4]) {
    it(`reports ${count} occurrences as ambiguous`, () => {
      const text = Array.from({ length: count }, () => "same").join("\n");
      expect(() => applyEdits(text, [{ oldText: "same", newText: "x" }], "f")).toThrow(`Found ${count} occurrences`);
    });
  }
  it("rejects empty oldText", () => {
    expect(() => applyEdits(content, [{ oldText: "", newText: "x" }], "f")).toThrow("must not be empty");
  });
  it("rejects overlapping edits", () => {
    expect(() =>
      applyEdits(
        "abcdef",
        [
          { oldText: "abcd", newText: "1" },
          { oldText: "cdef", newText: "2" },
        ],
        "f",
      ),
    ).toThrow("overlap");
  });
  it("rejects an edit that changes nothing", () => {
    expect(() => applyEdits(content, [{ oldText: "alpha", newText: "alpha" }], "f")).toThrow("No changes made");
  });
});

describe("applyEdits: fuzzy matching keeps untouched lines byte for byte", () => {
  for (const seed of range(40, 200)) {
    it(`matches ASCII quotes against curly quotes and trailing spaces (seed ${seed})`, () => {
      const rng = createRng(seed);
      const count = rng.int(3, 15);
      const lines = Array.from({ length: count }, (_, index) => `“quoted ${index}”${" ".repeat(rng.int(0, 3))}`);
      const target = rng.int(0, count - 1);
      const result = applyEdits(lines.join("\n"), [{ oldText: `"quoted ${target}"`, newText: `"changed ${target}"` }], "f").split("\n");
      lines.forEach((line, index) => {
        expect(result[index]).toBe(index === target ? `"changed ${target}"` : line);
      });
    });
  }

  for (const [name, original, asked] of [
    ["en dash", "range 1–5", "range 1-5"],
    ["em dash", "a — b", "a - b"],
    ["non-breaking space", "a b", "a b"],
    ["smart apostrophe", "it’s", "it's"],
  ] as Array<[string, string, string]>) {
    for (const variant of range(3)) {
      it(`matches ${name} (variant ${variant})`, () => {
        const result = applyEdits(`before\n${original}\nafter`, [{ oldText: asked, newText: "REPLACED" }], "f");
        expect(result).toBe("before\nREPLACED\nafter");
      });
    }
  }

  it("an exact match inside a line leaves trailing whitespace alone", () => {
    expect(applyEdits("before\nvalue\t\t\nafter", [{ oldText: "value", newText: "R" }], "f")).toBe("before\nR\t\t\nafter");
  });

  it("ambiguity is judged after normalisation", () => {
    expect(() => applyEdits("it’s\nit's", [{ oldText: "it's", newText: "x" }], "f")).toThrow("2 occurrences");
  });
});

describe("text helpers", () => {
  for (const [text, ending] of [
    ["a\nb", "\n"],
    ["a\r\nb", "\r\n"],
    ["a", "\n"],
    ["a\nb\r\nc", "\n"],
    ["a\r\nb\nc", "\r\n"],
    ["", "\n"],
  ] as Array<[string, string]>) {
    it(`detects the line ending of ${JSON.stringify(text)}`, () => {
      expect(detectLineEnding(text)).toBe(ending);
    });
  }
  for (const seed of range(20, 300)) {
    it(`CRLF round trip (seed ${seed})`, () => {
      const lines = randomFile(seed, 5).join("\n");
      expect(normalizeToLF(restoreLineEndings(lines, "\r\n"))).toBe(lines);
    });
  }
  it("splits a BOM off", () => {
    expect(splitBom("﻿hi")).toEqual({ bom: "﻿", text: "hi" });
    expect(splitBom("hi")).toEqual({ bom: "", text: "hi" });
  });
  it("normalisation is idempotent", () => {
    const once = normalizeForFuzzyMatch("“hi” — x  \nnext line");
    expect(normalizeForFuzzyMatch(once)).toBe(once);
  });
});

describe("edit tool", () => {
  it("edits a file and reports how many blocks", async () => {
    await box.env.writeFile("a.txt", "one\ntwo\nthree\n");
    const result = await run(editTool, box.env, { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("1 block");
    expect(decode(await box.env.readFile("a.txt"))).toBe("one\n2\nthree\n");
  });

  for (const seed of range(25, 400)) {
    it(`keeps CRLF line endings (seed ${seed})`, async () => {
      const lines = randomFile(seed, 6);
      await box.env.writeFile("w.txt", lines.join("\r\n") + "\r\n");
      const target = seed % 6;
      await run(editTool, box.env, { path: "w.txt", edits: [{ oldText: lines[target] as string, newText: "NEW" }] });
      const expected = lines.map((line, index) => (index === target ? "NEW" : line)).join("\r\n") + "\r\n";
      expect(decode(await box.env.readFile("w.txt"))).toBe(expected);
    });
  }

  for (const variant of range(5, 500)) {
    it(`keeps a BOM (variant ${variant})`, async () => {
      await box.env.writeFile("b.txt", "﻿hello world");
      await run(editTool, box.env, { path: "b.txt", edits: [{ oldText: "hello", newText: `bye${variant}` }] });
      expect(decode(await box.env.readFile("b.txt")).startsWith("﻿")).toBe(true);
    });
  }

  it("accepts the older single oldText/newText form", async () => {
    await box.env.writeFile("c.txt", "abc");
    const result = await run(editTool, box.env, { path: "c.txt", oldText: "b", newText: "X" });
    expect(result.isError).toBeUndefined();
    expect(decode(await box.env.readFile("c.txt"))).toBe("aXc");
  });
  it("can combine edits[] with the older form", async () => {
    await box.env.writeFile("c.txt", "abc");
    await run(editTool, box.env, { path: "c.txt", edits: [{ oldText: "a", newText: "1" }], oldText: "c", newText: "3" });
    expect(decode(await box.env.readFile("c.txt"))).toBe("1b3");
  });

  const bad: Array<[string, unknown, string]> = [
    ["a missing path", { edits: [] }, "'path'"],
    ["no edits", { path: "c.txt", edits: [] }, "at least one edit"],
    ["edits that are not an array", { path: "c.txt", edits: "x" }, "must be an array"],
    ["an edit without newText", { path: "c.txt", edits: [{ oldText: "a" }] }, "edits[0]"],
    ["arguments that are not an object", "nope", "must be an object"],
    ["a missing file", { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }, "File not found"],
    ["text that is not in the file", { path: "c.txt", edits: [{ oldText: "zzz", newText: "b" }] }, "Could not find"],
  ];
  for (const [name, args, message] of bad) {
    for (const variant of [1, 2]) {
      it(`reports ${name} as an error (variant ${variant})`, async () => {
        await box.env.writeFile("c.txt", "abc");
        const result = await run(editTool, box.env, args);
        expect(result.isError).toBe(true);
        expect(result.text).toContain(message);
      });
    }
  }

  it("refuses to edit a directory", async () => {
    await box.env.writeFile("d/x", "");
    expect((await run(editTool, box.env, { path: "d", edits: [{ oldText: "a", newText: "b" }] })).text).toContain("directory");
  });
  it("leaves the file untouched when an edit fails", async () => {
    await box.env.writeFile("e.txt", "keep me");
    await run(editTool, box.env, {
      path: "e.txt",
      edits: [
        { oldText: "keep", newText: "X" },
        { oldText: "missing", newText: "Y" },
      ],
    });
    expect(decode(await box.env.readFile("e.txt"))).toBe("keep me");
  });
});
