import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { foldHead, foldTail } from "../src/fold.ts";
import { range } from "./helpers.ts";

const lines = (count: number, width = 5) => Array.from({ length: count }, (_, index) => `L${index}`.padEnd(width, "x"));

describe("fold: line limits", () => {
  for (const total of [0, 1, 5, 10, 50, 100]) {
    for (const max of [1, 3, 10, 2000]) {
      it(`head keeps the first ${max} of ${total} lines`, () => {
        const result = foldHead(lines(total).join("\n"), { maxLines: max, maxBytes: 1e9 });
        expect(result.shownLines).toBe(Math.min(total, max));
        expect(result.truncated).toBe(total > max);
        expect(result.totalLines).toBe(total);
        if (total > 0) expect(result.text.split("\n")[0]).toBe(lines(total)[0]);
      });
      it(`tail keeps the last ${max} of ${total} lines`, () => {
        const result = foldTail(lines(total).join("\n"), { maxLines: max, maxBytes: 1e9 });
        expect(result.shownLines).toBe(Math.min(total, max));
        expect(result.truncated).toBe(total > max);
        if (total > 0) expect(result.text.split("\n").at(-1)).toBe(lines(total).at(-1));
      });
    }
  }
});

describe("fold: byte limits", () => {
  for (const seed of range(30)) {
    it(`never exceeds the byte limit (seed ${seed})`, () => {
      const rng = createRng(seed);
      const text = Array.from({ length: rng.int(1, 80) }, () => "é好x".repeat(rng.int(0, 15))).join("\n");
      const limit = rng.int(10, 400);
      for (const fold of [foldHead, foldTail]) {
        const result = fold(text, { maxLines: 1e9, maxBytes: limit });
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(limit);
        expect(result.text).not.toContain("�");
      }
    });
  }

  it("shows the start of a single huge line", () => {
    const result = foldHead("a".repeat(1000), { maxLines: 10, maxBytes: 100 });
    expect(result.text).toBe("a".repeat(100));
    expect(result.truncated).toBe(true);
  });
  it("shows the end of a single huge line when folding the tail", () => {
    const result = foldTail(`${"a".repeat(1000)}END`, { maxLines: 10, maxBytes: 100 });
    expect(result.text.endsWith("END")).toBe(true);
    expect(result.truncated).toBe(true);
  });
  it("does not split a multi-byte character", () => {
    const result = foldHead("好".repeat(50), { maxLines: 10, maxBytes: 100 });
    expect(Buffer.byteLength(result.text)).toBe(99);
  });
  it("leaves short text alone", () => {
    expect(foldHead("a\nb").truncated).toBe(false);
    expect(foldTail("a\nb").text).toBe("a\nb");
  });
  it("treats a trailing newline as the end of the last line", () => {
    expect(foldHead("a\nb\n").totalLines).toBe(2);
  });
});
