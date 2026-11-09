import { describe, expect, it } from "vitest";
import { foldHead, foldTail } from "../src/fold.ts";

// One line longer than the byte limit is cut inside the line, and never in the middle of a character.
describe("a single line over the byte limit", () => {
  const line = "日本語のテキスト".repeat(20); // 3 bytes per character
  for (const limit of [7, 8, 9, 10, 11, 31, 32, 33]) {
    it(`keeps whole characters at the start (${limit} bytes)`, () => {
      const folded = foldHead(line, { maxLines: 10, maxBytes: limit });
      expect(folded).toMatchObject({ truncated: true, shownLines: 1, totalLines: 1 });
      expect(Buffer.byteLength(folded.text)).toBeLessThanOrEqual(limit);
      expect(line.startsWith(folded.text)).toBe(true);
      expect(folded.text).not.toContain("�");
    });
    it(`keeps whole characters at the end (${limit} bytes)`, () => {
      const folded = foldTail(line, { maxLines: 10, maxBytes: limit });
      expect(folded).toMatchObject({ truncated: true, shownLines: 1, totalLines: 1 });
      expect(Buffer.byteLength(folded.text)).toBeLessThanOrEqual(limit);
      expect(line.endsWith(folded.text)).toBe(true);
      expect(folded.text).not.toContain("�");
    });
  }
  it("is returned whole when it fits", () => {
    expect(foldHead("日本", { maxLines: 10, maxBytes: 6 })).toMatchObject({ text: "日本", truncated: false });
    expect(foldTail("日本", { maxLines: 10, maxBytes: 6 })).toMatchObject({ text: "日本", truncated: false });
  });
});
