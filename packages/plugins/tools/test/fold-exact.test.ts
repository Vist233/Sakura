// Exact limits of the fold helpers and the output-saving plugin: where a line or byte limit is exactly reached, characters of more than one byte,
// and the wording of the notes.
import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Content, Tool } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import { preview, toolsPlugin } from "../src/artifacts.ts";
import { foldHead, foldTail } from "../src/fold.ts";
import { textOf, useSandbox } from "./helpers.ts";

const box = useSandbox();

describe("foldHead and foldTail: line limit", () => {
  const text = "l1\nl2\nl3\nl4\nl5";
  it("keeps exactly maxLines lines and says there were more", () => {
    expect(foldHead(text, { maxLines: 3, maxBytes: 1000 })).toEqual({ text: "l1\nl2\nl3", truncated: true, totalLines: 5, shownLines: 3 });
    expect(foldTail(text, { maxLines: 3, maxBytes: 1000 })).toEqual({ text: "l3\nl4\nl5", truncated: true, totalLines: 5, shownLines: 3 });
  });
  it("a limit equal to the number of lines is not a truncation", () => {
    expect(foldHead(text, { maxLines: 5, maxBytes: 1000 })).toEqual({ text, truncated: false, totalLines: 5, shownLines: 5 });
    expect(foldTail(text, { maxLines: 5, maxBytes: 1000 })).toEqual({ text, truncated: false, totalLines: 5, shownLines: 5 });
  });
  it("empty text has no lines; a final newline is not another line", () => {
    for (const fold of [foldHead, foldTail]) {
      expect(fold("")).toEqual({ text: "", truncated: false, totalLines: 0, shownLines: 0 });
      expect(fold("a\nb\n", { maxLines: 10, maxBytes: 100 })).toEqual({ text: "a\nb", truncated: false, totalLines: 2, shownLines: 2 });
    }
  });
});

describe("foldHead and foldTail: byte limit (the shown text, newlines between lines included, never exceeds it)", () => {
  it("a line that brings the total to exactly maxBytes still fits; one byte less room does not", () => {
    expect(foldHead("ab\ncd", { maxLines: 10, maxBytes: 5 })).toMatchObject({ text: "ab\ncd", truncated: false, shownLines: 2 });
    expect(foldHead("ab\ncd", { maxLines: 10, maxBytes: 4 })).toMatchObject({ text: "ab", truncated: true, shownLines: 1 });
    expect(foldTail("ab\ncd", { maxLines: 10, maxBytes: 5 })).toMatchObject({ text: "ab\ncd", truncated: false, shownLines: 2 });
    expect(foldTail("ab\ncd", { maxLines: 10, maxBytes: 4 })).toMatchObject({ text: "cd", truncated: true, shownLines: 1 });
  });

  it("bytes are counted, not characters", () => {
    expect(foldHead("éé\nxx", { maxLines: 10, maxBytes: 7 })).toMatchObject({ text: "éé\nxx", truncated: false }); // 4 + 1 + 2 bytes
    expect(foldHead("éé\nxx", { maxLines: 10, maxBytes: 6 })).toMatchObject({ text: "éé", truncated: true });
  });

  it("one line longer than the limit is cut, never in the middle of a character (head)", () => {
    expect(foldHead("é".repeat(10), { maxLines: 5, maxBytes: 5 })).toEqual({ text: "éé", truncated: true, totalLines: 1, shownLines: 1 });
    expect(foldHead("日本語日本語", { maxLines: 5, maxBytes: 7 })).toMatchObject({ text: "日本" });
    expect(foldHead("x".repeat(100), { maxLines: 5, maxBytes: 10 })).toMatchObject({ text: "xxxxxxxxxx", truncated: true });
  });

  it("one line longer than the limit is cut, never in the middle of a character (tail)", () => {
    expect(foldTail("é".repeat(10), { maxLines: 5, maxBytes: 5 })).toEqual({ text: "éé", truncated: true, totalLines: 1, shownLines: 1 });
    expect(foldTail("日本語日本語", { maxLines: 5, maxBytes: 7 })).toMatchObject({ text: "本語" });
    expect(foldTail("x".repeat(100), { maxLines: 5, maxBytes: 10 })).toMatchObject({ text: "xxxxxxxxxx", truncated: true });
  });
});

describe("preview", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `n${index}`).join("\n");
  it("text that fits both limits gets no preview, exactly at either limit", () => {
    expect(preview("ab\ncd", { keep: "both", maxLines: 2, maxBytes: 5 })).toBeUndefined();
    expect(preview("ab\ncd", { keep: "both", maxLines: 1, maxBytes: 5 })).toBeDefined();
    expect(preview("ab\ncd", { keep: "both", maxLines: 2, maxBytes: 4 })).toBeDefined();
  });
  it("a long single line is shortened by bytes even though it is one line", () => {
    expect(preview("x".repeat(100), { keep: "head", maxLines: 10, maxBytes: 10 })).toEqual({ text: "xxxxxxxxxx", totalLines: 1 });
  });
  it("head and tail each get half of the limits, rounded down, and the gap is counted", () => {
    const short = preview(lines(100), { keep: "both", maxLines: 10, maxBytes: 1e9 })!;
    expect(short.text).toBe(`${lines(5)}\n[... 90 lines left out ...]\n${Array.from({ length: 5 }, (_, index) => `n${95 + index}`).join("\n")}`);
    expect(short.totalLines).toBe(100);
  });
  it("an odd limit rounds the halves down, but never below one line or byte", () => {
    const short = preview(lines(50), { keep: "both", maxLines: 3, maxBytes: 1e9 })!;
    expect(short.text).toBe("n0\n[... 48 lines left out ...]\nn49");
    expect(preview(lines(50), { keep: "both", maxLines: 1, maxBytes: 1e9 })!.text).toBe("n0\n[... 48 lines left out ...]\nn49");
  });
});

describe("the output-saving plugin", () => {
  const tool = (name: string, content: Content[]): Tool => ({ name, description: "", parameters: {}, effect: "read", execute: async () => ({ content }) });
  async function run(callTool: Tool, plugin = toolsPlugin()) {
    const llm = createFauxClient([{ toolCalls: [{ name: callTool.name, args: {}, id: "c/1 weird:id" }] }, { text: "done" }]);
    const log = createMemoryLog();
    const handle = createKernel({ llm, env: box.env, system: "s", tools: [callTool], plugins: [plugin], compaction: false, now: () => 1 }).run(log, "go");
    for await (const _event of handle.events) void _event;
    await handle.result;
    return (await log.project()).find((message) => message.role === "tool")!;
  }
  const manyLines = (count: number) => Array.from({ length: count }, (_, index) => `row ${index}`).join("\n");

  it("a result at the default limit of 2000 lines is left alone; 2001 lines are shortened", async () => {
    expect(textOf((await run(tool("t", [{ type: "text", text: manyLines(2000) }]))).content)).toBe(manyLines(2000));
    const folded = textOf((await run(tool("t", [{ type: "text", text: manyLines(2001) }]))).content);
    expect(folded).toContain("lines left out");
    expect(folded).toContain("The output was too long to show in full.");
  });

  it("the default byte limit is 50 KB", async () => {
    expect(textOf((await run(tool("t", [{ type: "text", text: "x".repeat(50 * 1024) }]))).content)).toHaveLength(50 * 1024);
    expect(textOf((await run(tool("t", [{ type: "text", text: "x".repeat(50 * 1024 + 1) }]))).content)).toContain("too long");
  });

  it("the full output is saved under a file name made from the call id, and the note names the file and the line count", async () => {
    const message = await run(tool("t", [{ type: "text", text: manyLines(3000) }]), toolsPlugin({ directory: `${box.dir}/saved` }));
    const note = textOf(message.content);
    expect(note).toContain(`The full output (3000 lines) is saved in ${box.dir}/saved/c_1_weird_id.txt; use read with offset and limit`);
    expect(new TextDecoder().decode(await box.env.readFile(`${box.dir}/saved/c_1_weird_id.txt`))).toBe(manyLines(3000));
  });

  it("an output that cannot be saved still gets a preview that says so", async () => {
    const broken = { ...box.env, writeFile: async () => Promise.reject(new Error("read-only")) };
    const llm = createFauxClient([{ toolCalls: [{ name: "t", args: {}, id: "c" }] }, { text: "done" }]);
    const log = createMemoryLog();
    const handle = createKernel({ llm, env: broken, system: "s", tools: [tool("t", [{ type: "text", text: manyLines(3000) }])], plugins: [toolsPlugin()], compaction: false, now: () => 1 }).run(
      log,
      "go",
    );
    for await (const _event of handle.events) void _event;
    expect(textOf((await log.project()).find((message) => message.role === "tool")!.content)).toContain("The rest could not be saved.");
  });

  it("images stay, text parts are joined by a newline, and parts of other kinds are not counted as text", async () => {
    const message = await run(
      tool("t", [
        { type: "image", mediaType: "image/png", ref: "r" },
        { type: "text", text: manyLines(3000) },
        { type: "text", text: "tail part" },
      ]),
    );
    expect(message.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(textOf(message.content)).toContain("tail part");
  });

  it("a rule by tool name, a changed default and the skip list decide what is shortened", async () => {
    const text = manyLines(30);
    const plugin = toolsPlugin({ default: { keep: "head", maxLines: 10, maxBytes: 1e9 }, rules: { special: { keep: "tail", maxLines: 5, maxBytes: 1e9 } }, skip: ["skipped"] });
    expect(textOf((await run(tool("plain", [{ type: "text", text }]), plugin)).content)).toMatch(/^row 0\n.*row 9\n\n\[/s);
    expect(textOf((await run(tool("special", [{ type: "text", text }]), plugin)).content)).toMatch(/^row 25\n/);
    expect(textOf((await run(tool("skipped", [{ type: "text", text }]), plugin)).content)).toBe(text);
  });

  it("names itself and says what it compensates", () => {
    const plugin = toolsPlugin();
    expect(plugin.name).toBe("tools");
    expect(plugin.compensates).toBe("models cannot cope with unlimited tool output");
  });

  it("without a run having started (no environment known) the preview is given without a file note", async () => {
    const plugin = toolsPlugin();
    const hooks: Record<string, (...args: never[]) => unknown> = {};
    plugin.setup({ on: (name: string, handler: never) => (hooks[name] = handler), registerTool: () => undefined, emit: () => undefined } as never);
    const result = (await (hooks["tool.run"] as any)({ id: "c", name: "t", args: {} }, async () => ({ content: [{ type: "text", text: manyLines(3000) }] }))) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text.endsWith("\n\n[The output was too long to show in full.]")).toBe(true);
  });
});
