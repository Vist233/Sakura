import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { readTool } from "../src/builtin/read.ts";
import { writeTool } from "../src/builtin/write.ts";
import { solidPngBytes } from "./png.ts";
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
  for (const [name, extension, type] of [
    ["png", ".png", "image/png"],
    ["jpeg", ".jpg", "image/jpeg"],
    ["gif", ".GIF", "image/gif"],
    ["webp", ".webp", "image/webp"],
  ]) {
    it(`returns ${name} files as images`, async () => {
      await writeFile(join(box.dir, `pic${extension}`), solidPngBytes());
      const result = await run(readTool, box.env, { path: `pic${extension}` });
      expect(result.content.find((part) => part.type === "image")).toMatchObject({ mediaType: type, ref: join(box.dir, `pic${extension}`) });
    });
  }
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
