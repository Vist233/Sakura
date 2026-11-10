import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { readTool } from "../src/builtin/read.ts";
import { writeTool } from "../src/builtin/write.ts";
import { decode, range, run, useSandbox } from "./helpers.ts";

const box = useSandbox();
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("read", () => {
  for (const seed of range(40)) {
    it(`reads a whole small file (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const content = Array.from({ length: rng.int(1, 50) }, () => `row ${rng.int(0, 9999)} é好`).join("\n") + (rng.chance(0.5) ? "\n" : "");
      await box.env.writeFile("f.txt", content);
      const result = await run(readTool, box.env, { path: "f.txt" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toBe(content.replace(/\n$/, ""));
    });
  }

  for (const offset of [1, 2, 10, 50, 99, 100]) {
    for (const limit of [undefined, 1, 5, 200]) {
      it(`offset ${offset} limit ${limit ?? "none"}`, async () => {
        await box.env.writeFile("n.txt", numbered(100));
        const result = await run(readTool, box.env, { path: "n.txt", offset, ...(limit ? { limit } : {}) });
        expect(result.text.split("\n")[0]).toBe(`line ${offset}`);
        const shown = Math.min(limit ?? 1000, 100 - offset + 1);
        expect(result.text).toContain(`line ${offset + shown - 1}`);
        if (limit && offset + limit - 1 < 100) expect(result.text).toContain("more lines in file");
      });
    }
  }

  it("truncates at 2000 lines and says how to continue", async () => {
    await box.env.writeFile("big.txt", numbered(2500));
    const result = await run(readTool, box.env, { path: "big.txt" });
    expect(result.text).toContain("line 2000");
    expect(result.text).not.toContain("line 2001\n");
    expect(result.text).toContain("Use offset=2001 to continue");
  });
  it("continues where the notice says", async () => {
    await box.env.writeFile("big.txt", numbered(2500));
    const result = await run(readTool, box.env, { path: "big.txt", offset: 2001 });
    expect(result.text.startsWith("line 2001")).toBe(true);
    expect(result.text).toContain("line 2500");
    expect(result.text).not.toContain("to continue");
  });
  it("truncates at 50KB", async () => {
    await box.env.writeFile("wide.txt", Array.from({ length: 200 }, () => "x".repeat(1000)).join("\n"));
    const result = await run(readTool, box.env, { path: "wide.txt" });
    expect(result.text).toContain("to continue");
    expect(Buffer.byteLength(result.text)).toBeLessThan(52_000);
  });

  it("returns an empty string for an empty file", async () => {
    await box.env.writeFile("e.txt", "");
    expect((await run(readTool, box.env, { path: "e.txt" })).text).toBe("");
  });
  it("refuses an offset past the end", async () => {
    await box.env.writeFile("s.txt", numbered(3));
    const result = await run(readTool, box.env, { path: "s.txt", offset: 4 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("3 lines");
  });
  it("reports a missing file and a directory", async () => {
    await box.env.writeFile("d/x", "");
    expect((await run(readTool, box.env, { path: "nope" })).text).toContain("File not found");
    expect((await run(readTool, box.env, { path: "d" })).text).toContain("directory");
  });
  it("refuses binary files", async () => {
    await writeFile(join(box.dir, "b.bin"), Buffer.from([1, 2, 0, 3]));
    expect((await run(readTool, box.env, { path: "b.bin" })).text).toContain("binary");
  });
  for (const [name, extension, type, bytes] of [
    ["png", ".png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]],
    ["jpeg", ".jpg", "image/jpeg", [0xff, 0xd8, 0xff, 0xe0, 0, 0]],
    ["gif", ".GIF", "image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["webp", ".webp", "image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
  ] as Array<[string, string, string, number[]]>) {
    it(`returns ${name} files as images`, async () => {
      await writeFile(join(box.dir, `pic${extension}`), Buffer.from(bytes));
      const result = await run(readTool, box.env, { path: `pic${extension}` });
      expect(result.content.find((part) => part.type === "image")).toMatchObject({ mediaType: type, ref: join(box.dir, `pic${extension}`) });
    });
  }
  it("sends the type the bytes have, not the one the name says", async () => {
    await writeFile(join(box.dir, "really-jpeg.png"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const result = await run(readTool, box.env, { path: "really-jpeg.png" });
    expect(result.content.find((part) => part.type === "image")).toMatchObject({ mediaType: "image/jpeg" });
  });
  it("shows a file named like a picture that is text as text", async () => {
    await writeFile(join(box.dir, "notes.png"), "not a picture\n");
    const result = await run(readTool, box.env, { path: "notes.png" });
    expect(result.text).toBe("not a picture");
    expect(result.content.some((part) => part.type === "image")).toBe(false);
  });
  it("calls a file named like a picture that is binary a binary file", async () => {
    await writeFile(join(box.dir, "junk.jpg"), Buffer.from([1, 2, 0, 3]));
    const result = await run(readTool, box.env, { path: "junk.jpg" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("binary");
  });
  const bad: Array<[string, unknown]> = [
    ["no path", {}],
    ["path not a string", { path: 5 }],
    ["offset 0", { path: "a", offset: 0 }],
    ["offset fractional", { path: "a", offset: 1.5 }],
    ["limit negative", { path: "a", limit: -1 }],
    ["offset a string", { path: "a", offset: "1" }],
  ];
  for (const [name, args] of bad) {
    it(`rejects ${name}`, async () => {
      await box.env.writeFile("a", "x");
      expect((await run(readTool, box.env, args)).isError).toBe(true);
    });
  }
  it("reads files given by absolute path", async () => {
    await box.env.writeFile("abs.txt", "hello");
    expect((await run(readTool, box.env, { path: join(box.dir, "abs.txt") })).text).toBe("hello");
  });
});

describe("write", () => {
  for (const seed of range(30, 100)) {
    it(`writes content exactly (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const content = Array.from({ length: rng.int(0, 100) }, () => String.fromCharCode(rng.int(1, 0x2fff))).join("");
      const path = `out${rng.int(0, 3)}/n${seed}.txt`;
      const result = await run(writeTool, box.env, { path, content });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain(`${Buffer.byteLength(content)} bytes`);
      expect(decode(await box.env.readFile(path))).toBe(content);
    });
  }
  it("overwrites an existing file", async () => {
    await box.env.writeFile("o", "old old old");
    await run(writeTool, box.env, { path: "o", content: "new" });
    expect(decode(await box.env.readFile("o"))).toBe("new");
  });
  it("refuses to write over a directory", async () => {
    await box.env.writeFile("dir/x", "");
    expect((await run(writeTool, box.env, { path: "dir", content: "x" })).isError).toBe(true);
  });
  for (const [name, args] of [
    ["no content", { path: "a" }],
    ["no path", { content: "x" }],
    ["numbers", { path: "a", content: 5 }],
  ] as Array<[string, unknown]>) {
    it(`rejects ${name}`, async () => {
      expect((await run(writeTool, box.env, args)).isError).toBe(true);
    });
  }
  it("writes an empty file", async () => {
    await run(writeTool, box.env, { path: "empty", content: "" });
    expect((await box.env.stat("empty"))?.size).toBe(0);
  });
});
