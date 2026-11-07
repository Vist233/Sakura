import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, Tool, ToolContext } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import type { FauxScript } from "@sakura/testing";
import { searchPlugin } from "../src/index.ts";

const env = { cwd: "/w", resolve: (p: string) => p, dispose: async () => undefined } as unknown as Environment;
const make = (name: string, description: string, run: Tool["execute"] = async () => ({ content: [{ type: "text", text: `ran ${name}` }] })): Tool => ({
  name,
  description,
  parameters: { type: "object", properties: { x: { type: "string" } } },
  effect: "read",
  execute: run,
});
const catalog = [
  make("create_issue", "Create an issue in the tracker"),
  make("send_email", "Send an email to a person"),
  make("list_events", "List calendar events"),
  make("search_pages", "Search the web for pages"),
  make("read_sheet", "Read a spreadsheet"),
  make("write_sheet", "Write a spreadsheet"),
  make("add_comment", "Add a comment to an issue"),
];

async function drive(script: FauxScript, options: { limit?: number; catalog?: Tool[] } = {}) {
  const llm = createFauxClient(script);
  const kernel = createKernel({
    llm,
    env,
    system: "s",
    tools: [],
    plugins: [searchPlugin({ catalog: options.catalog ?? catalog, ...(options.limit ? { limit: options.limit } : {}) })],
    compaction: false,
    now: () => 1,
  });
  const log = createMemoryLog();
  const handle = kernel.run(log, "go");
  for await (const _event of handle.events) void _event;
  await handle.result;
  const results = (await log.project()).filter((message) => message.role === "tool").map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
  return { llm, results, log };
}
const search = (query: unknown, id = "s") => ({ toolCalls: [{ name: "tool_search", args: { query }, id }] });
const call = (name: unknown, args: unknown, id = "c") => ({ toolCalls: [{ name: "tool_call", args: { name, args }, id }] });

describe("search plugin", () => {
  it("declares only tool_search and tool_call to the model", async () => {
    const { llm } = await drive([{ text: "hi" }]);
    expect(llm.requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(["tool_call", "tool_search"]);
  });

  for (const [query, expected] of [
    ["email person", "send_email"],
    ["calendar", "list_events"],
    ["issue tracker", "create_issue"],
    ["spreadsheet read", "read_sheet"],
  ] as const) {
    it(`tool_search '${query}' finds ${expected} first`, async () => {
      const { results } = await drive([search(query), { text: "ok" }]);
      expect(results[0]!.startsWith(`${expected}:`)).toBe(true);
      expect(results[0]).toContain("parameters:");
    });
  }

  it("returns at most `limit` matches", async () => {
    const { results } = await drive([search("sheet issue comment spreadsheet"), { text: "ok" }], { limit: 2 });
    expect(results[0]!.split("\n\n")).toHaveLength(2);
  });

  it("says so when nothing matches, and rejects an empty query", async () => {
    const { results } = await drive([search("zebra"), search("   ", "s2"), { text: "ok" }]);
    expect(results[0]).toContain("No tool matches");
    expect(results[1]).toContain("non-empty");
  });

  it("tool_call runs a catalog tool with the arguments and the tool context", async () => {
    let seen: { args: unknown; callId?: string } | undefined;
    const spy = make("spy_tool", "Spy", async (args: unknown, context: ToolContext) => {
      seen = { args, callId: context.callId };
      return { content: [{ type: "text", text: "spied" }] };
    });
    const { results } = await drive([call("spy_tool", { x: "1" }, "cc"), { text: "ok" }], { catalog: [spy] });
    expect(results[0]).toBe("spied");
    expect(seen).toEqual({ args: { x: "1" }, callId: "cc" });
  });

  it("tool_call on an unknown name or a bad name is an error the model can read", async () => {
    const { results } = await drive([call("nope", {}), call(5, {}, "c2"), { text: "ok" }]);
    expect(results[0]).toContain("no tool named 'nope'");
    expect(results[1]).toContain("'name' must be a string");
  });

  it("a catalog tool that throws becomes an error result, not a crash", async () => {
    const bad = make("bad", "Bad tool", async () => {
      throw new Error("boom");
    });
    const { results } = await drive([call("bad", {}), { text: "ok" }], { catalog: [bad] });
    expect(results[0]).toContain("boom");
  });

  it("an error result from a catalog tool keeps its isError flag", async () => {
    const failing = make("failing", "Fails", async () => ({ content: [{ type: "text", text: "no" }], isError: true }));
    const { log } = await drive([call("failing", {}), { text: "ok" }], { catalog: [failing] });
    const toolMessage = (await log.project()).find((message) => message.role === "tool");
    expect(toolMessage?.isError).toBe(true);
  });
});
