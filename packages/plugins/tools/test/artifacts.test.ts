import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, Tool } from "@sakura/kernel";
import { createLocalEnvironment } from "@sakura/env";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient, createRng } from "@sakura/testing";
import { preview, toolsPlugin } from "../src/artifacts.ts";
import { builtinTools } from "../src/index.ts";
import { decode, range, textOf, useSandbox } from "./helpers.ts";

const box = useSandbox();
const lines = (count: number, width = 8) => Array.from({ length: count }, (_, index) => `line ${index}`.padEnd(width, ".")).join("\n");
const big = (count: number): Tool => ({ name: "big", description: "", parameters: {}, effect: "read", execute: async () => ({ content: [{ type: "text", text: lines(count) }] }) });

async function runTool(tool: Tool, plugin = toolsPlugin(), callId = "call-1") {
  const llm = createFauxClient([{ toolCalls: [{ name: tool.name, args: {}, id: callId }] }, { text: "done" }]);
  const kernel = createKernel({ llm, env: box.env, system: "s", tools: [tool], plugins: [plugin], compaction: false, now: () => 1 });
  const log = createMemoryLog();
  const handle = kernel.run(log, "go");
  for await (const _event of handle.events) void _event;
  await handle.result;
  const result = (await log.project()).find((message) => message.role === "tool")!;
  return { result, text: textOf(result.content), llm };
}

describe("preview", () => {
  const rule = (keep: "head" | "tail" | "both", maxLines: number, maxBytes = 1e9) => ({ keep, maxLines, maxBytes });
  for (const count of [1, 10, 100, 2000]) {
    it(`leaves ${count} short lines alone when they fit`, () => {
      expect(preview(lines(count), rule("both", 2000))).toBeUndefined();
    });
  }
  for (const keep of ["head", "tail", "both"] as const) {
    for (const count of [101, 500, 5000]) {
      it(`keeps the ${keep} of ${count} lines`, () => {
        const short = preview(lines(count), rule(keep, 100))!;
        expect(short.totalLines).toBe(count);
        const shown = short.text.split("\n");
        if (keep === "head") expect(shown[0]).toBe("line 0.."), expect(shown.length).toBe(100);
        if (keep === "tail") expect(shown.at(-1)).toBe(`line ${count - 1}`.padEnd(8, ".")), expect(shown.length).toBe(100);
        if (keep === "both") {
          expect(shown[0]).toBe("line 0..");
          expect(shown.at(-1)).toBe(`line ${count - 1}`.padEnd(8, "."));
          expect(short.text).toMatch(/\[\.\.\. \d+ lines left out \.\.\.\]/);
        }
      });
    }
  }
  it("counts the lines left out", () => {
    const short = preview(lines(1000), rule("both", 100))!;
    const omitted = Number(short.text.match(/(\d+) lines left out/)![1]);
    expect(short.text.split("\n").length - 1 + omitted).toBe(1000);
  });
  for (const seed of range(20)) {
    it(`never exceeds the byte limit even with multi-byte text (seed ${seed})`, () => {
      const rng = createRng(seed);
      const text = Array.from({ length: rng.int(50, 400) }, () => "é好x".repeat(rng.int(1, 20))).join("\n");
      const limit = rng.int(200, 2000);
      const short = preview(text, { keep: "both", maxLines: 1e9, maxBytes: limit });
      if (short) expect(Buffer.byteLength(short.text)).toBeLessThanOrEqual(limit + 80);
    });
  }
  it("a long single line is cut by bytes", () => {
    expect(preview("x".repeat(100_000), rule("head", 100, 1000))!.text.length).toBeLessThanOrEqual(1000);
  });
});

describe("the tools plugin", () => {
  for (const count of [10, 1000, 2000]) {
    it(`a result of ${count} lines passes through unchanged`, async () => {
      const { text } = await runTool(big(count));
      expect(text).toBe(lines(count));
    });
  }

  for (const count of [2001, 5000, 40000]) {
    it(`a result of ${count} lines is replaced by a preview and the full text is saved`, async () => {
      const { text } = await runTool(big(count));
      expect(text.length).toBeLessThan(60_000);
      expect(text).toContain("too long to show in full");
      expect(text).toContain(`${count} lines`);
      const path = text.match(/saved in (\S+?);/)![1]!;
      expect(path).toBe(".sakura/artifacts/call-1.txt");
      expect(decode(await box.env.readFile(path))).toBe(lines(count));
    });
  }

  it("the model can read the saved file in pieces with the read tool", async () => {
    const { text } = await runTool(big(5000));
    const path = text.match(/saved in (\S+?);/)![1]!;
    const read = builtinTools(["read"])[0]!;
    const piece = await read.execute(
      { path, offset: 3000, limit: 3 },
      { env: box.env, signal: new AbortController().signal, callId: "x", log: createMemoryLog(), notify: () => undefined, watch: () => () => undefined },
    );
    expect(textOf(piece.content)).toContain("line 2999");
  });

  it("different calls get different files", async () => {
    const one = await runTool(big(3000), toolsPlugin(), "a");
    const two = await runTool(big(3000), toolsPlugin(), "b");
    expect(one.text).toContain(".sakura/artifacts/a.txt");
    expect(two.text).toContain(".sakura/artifacts/b.txt");
  });
  it("odd characters in a call id are made safe for a file name", async () => {
    const { text } = await runTool(big(3000), toolsPlugin(), "call/../x y");
    expect(text).toMatch(/\.sakura\/artifacts\/call_.._x_y\.txt/);
  });

  it("keeps an error flag and images", async () => {
    const tool: Tool = {
      name: "mixed",
      description: "",
      parameters: {},
      effect: "read",
      execute: async () => ({
        isError: true,
        content: [
          { type: "text", text: lines(3000) },
          { type: "image", mediaType: "image/png", ref: "p.png" },
        ],
      }),
    };
    const { result } = await runTool(tool);
    expect(result.isError).toBe(true);
    expect(result.content.some((part) => part.type === "image")).toBe(true);
  });

  for (const name of ["read", "write", "edit", "bash"]) {
    it(`leaves the output of ${name} to the tool itself`, async () => {
      const tool: Tool = { ...big(5000), name };
      const { text } = await runTool(tool);
      expect(text).toBe(lines(5000));
    });
  }
  it("the skip list can be changed", async () => {
    const { text } = await runTool({ ...big(5000), name: "read" }, toolsPlugin({ skip: [] }));
    expect(text).toContain("too long to show in full");
  });

  it("a rule for one tool overrides the default", async () => {
    const { text } = await runTool(big(500), toolsPlugin({ rules: { big: { keep: "head", maxLines: 20, maxBytes: 1e9 } } }));
    expect(text.split("\n").slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, index) => `line ${index}`.padEnd(8, ".")));
    expect(text).not.toContain("lines left out");
  });
  it("a different default applies to every tool without a rule", async () => {
    const { text } = await runTool(big(500), toolsPlugin({ default: { keep: "tail", maxLines: 10, maxBytes: 1e9 } }));
    expect(text).toContain(`line 499`);
    expect(text).not.toContain("line 0.");
  });
  it("saves to another directory when asked", async () => {
    const { text } = await runTool(big(3000), toolsPlugin({ directory: ".sakura/custom-artifacts" }));
    expect(text).toContain(".sakura/custom-artifacts/call-1.txt");
  });

  it("still gives a preview when the file cannot be written", async () => {
    const broken: Environment = {
      ...box.env,
      writeFile: async () => {
        throw new Error("disk full");
      },
    };
    const llm = createFauxClient([{ toolCalls: [{ name: "big", args: {}, id: "c" }] }, { text: "done" }]);
    const kernel = createKernel({ llm, env: broken, system: "s", tools: [big(3000)], plugins: [toolsPlugin()], compaction: false, now: () => 1 });
    const log = createMemoryLog();
    const handle = kernel.run(log, "go");
    for await (const _event of handle.events) void _event;
    const text = textOf((await log.project()).find((message) => message.role === "tool")!.content);
    expect(text).toContain("could not be saved");
    expect(text.length).toBeLessThan(60_000);
  });

  it("the conversation really stays small: the log holds the preview, not the full text", async () => {
    const { result } = await runTool(big(40000));
    expect(JSON.stringify(result).length).toBeLessThan(70_000);
  });

  it("works with a remote-style environment object too (only writeFile is needed)", async () => {
    const saved: Array<[string, string]> = [];
    const stub: Environment = { ...box.env, writeFile: async (path, data) => void saved.push([path, String(data)]) };
    const kernel = createKernel({
      llm: createFauxClient([{ toolCalls: [{ name: "big", args: {}, id: "c" }] }, { text: "done" }]),
      env: stub,
      system: "s",
      tools: [big(3000)],
      plugins: [toolsPlugin()],
      compaction: false,
      now: () => 1,
    });
    const handle = kernel.run(createMemoryLog(), "go");
    for await (const _event of handle.events) void _event;
    expect(saved[0]![0]).toBe(".sakura/artifacts/c.txt");
    expect(saved[0]![1]).toBe(lines(3000));
  });

  void createLocalEnvironment;
});
