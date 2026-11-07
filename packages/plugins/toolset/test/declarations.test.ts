// What the model is shown about the tools of this package, word for word. A change to a description or a schema is a change to how the
// model behaves, so it has to be made on purpose: it shows up here.
import { describe, expect, it } from "vitest";
import type { Tool, ToolContext } from "@sakura/kernel";
import { codemodePlugin, searchPlugin } from "../src/index.ts";

function declared(plugin: { setup(api: never): void }): Array<Omit<Tool, "execute"> & { execute: Tool["execute"] }> {
  const found: Tool[] = [];
  plugin.setup({ on: () => undefined, registerTool: (tool: Tool) => found.push(tool), emit: () => undefined } as never);
  return found;
}
const strip = ({ execute: _execute, ...rest }: Tool) => rest;
const context = { env: undefined as never, signal: new AbortController().signal, callId: "c", log: undefined as never, notify: () => undefined, watch: () => () => undefined } as ToolContext;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");
const read = (name: string): Tool => ({
  name,
  description: `Does ${name}`,
  parameters: { type: "object" },
  effect: "read",
  execute: async (args) => ({ content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] }),
});

describe("the search plugin's declarations", () => {
  const plugin = searchPlugin({ catalog: [read("alpha")] });
  const [search, call] = declared(plugin);

  it("has a name and says what it compensates", () => {
    expect(plugin.name).toBe("search");
    expect(plugin.compensates).toBe("a long list of tool declarations fills every request and confuses the model");
  });

  it("tool_search", () => {
    expect(strip(search!)).toEqual({
      name: "tool_search",
      description: "Finds tools that are not listed in your tool set. Describe what you need in a few words. Returns the best matches with their descriptions and parameters; run one with tool_call.",
      parameters: { type: "object", properties: { query: { type: "string", description: "What you want to do" } }, required: ["query"] },
      effect: "read",
    });
  });

  it("tool_call", () => {
    expect(strip(call!)).toEqual({
      name: "tool_call",
      description: "Runs a tool found with tool_search. 'name' is the tool's name and 'args' are its arguments, as its parameters describe.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Name of the tool" }, args: { type: "object", description: "Arguments for the tool" } },
        required: ["name"],
      },
      effect: "exec",
      replay: "never",
    });
  });
});

describe("the search plugin's answers", () => {
  const [search, call] = declared(searchPlugin({ catalog: [read("alpha")] }));
  const error = (text: string) => ({ content: [{ type: "text", text }], isError: true });

  it("a match is returned as a result without an isError key", async () => {
    expect(await search!.execute({ query: "alpha" }, context)).toEqual({ content: [{ type: "text", text: `alpha: Does alpha\nparameters: {"type":"object"}` }] });
  });
  it("no match says so", async () => {
    expect(await search!.execute({ query: "zebra" }, context)).toEqual({ content: [{ type: "text", text: "No tool matches 'zebra'. Try other words." }] });
  });
  for (const bad of [undefined, null, {}, { query: 5 }, { query: "" }, { query: "   " }, "alpha", 7]) {
    it(`tool_search with ${JSON.stringify(bad)} asks for a query`, async () => expect(await search!.execute(bad, context)).toEqual(error("'query' must be a non-empty string.")));
  }
  for (const bad of [undefined, null, {}, { name: 5 }, "alpha"]) {
    it(`tool_call with ${JSON.stringify(bad)} asks for a name`, async () => expect(await call!.execute(bad, context)).toEqual(error("'name' must be a string.")));
  }
  it("an unknown tool is named in the error", async () => {
    expect(await call!.execute({ name: "beta" }, context)).toEqual(error("There is no tool named 'beta'. Use tool_search to find one."));
  });
  it("tool_call passes the arguments on, or an empty object", async () => {
    expect(textOf((await call!.execute({ name: "alpha", args: { a: 1 } }, context)) as never)).toBe('alpha:{"a":1}');
    expect(textOf((await call!.execute({ name: "alpha" }, context)) as never)).toBe("alpha:{}");
  });
});

describe("the codemode plugin's declaration", () => {
  const plugin = codemodePlugin({ catalog: [read("alpha"), read("beta")] });
  const [runCode] = declared(plugin);

  it("has a name and says what it compensates", () => {
    expect(plugin.name).toBe("codemode");
    expect(plugin.compensates).toBe("one tool call per model request is slow and fills the context with intermediate results");
  });

  it("run_code", () => {
    expect(strip(runCode!)).toEqual({
      name: "run_code",
      description:
        "Runs a short JavaScript program in a sandbox (no files, no network, no timers) and returns what it prints and returns. " +
        "Inside the program, `tools.<name>(args)` calls a tool and returns a promise of its text; use `await`. `console.log` output is returned. " +
        "Use it to combine several tool calls or to process their results without sending everything through the conversation. Available tools: alpha, beta",
      parameters: { type: "object", properties: { code: { type: "string", description: "The body of an async function; use `return` for the result" } }, required: ["code"] },
      effect: "exec",
      replay: "never",
    });
  });

  for (const bad of [undefined, null, {}, { code: 5 }, { code: "" }, { code: "  \n " }]) {
    it(`run_code with ${JSON.stringify(bad)} asks for code`, async () => {
      expect(await runCode!.execute(bad, context)).toEqual({ content: [{ type: "text", text: "'code' must be a non-empty string." }], isError: true });
    });
  }
});
