import type { Content, Plugin, Tool } from "@sakura/kernel";
import { rank } from "./bm25.ts";

export interface SearchOptions {
  /** The tools that are not declared to the model one by one; it finds them with tool_search and runs them with tool_call. */
  catalog: Tool[];
  /** How many matches tool_search returns at most (default 5). */
  limit?: number;
}

const text = (value: string, isError = false): { content: Content[]; isError?: boolean } => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

const SEARCH_DESCRIPTION =
  "Finds tools that are not listed in your tool set. Describe what you need in a few words. Returns the best matches with their descriptions and parameters; run one with tool_call.";
const CALL_DESCRIPTION = "Runs a tool found with tool_search. 'name' is the tool's name and 'args' are its arguments, as its parameters describe.";

/**
 * Keeps a large set of tools out of every request: only tool_search and tool_call are declared.
 * The catalog tools run through tool_call, so they pass the same hooks (review, limits) as any call.
 */
export function searchPlugin(options: SearchOptions): Plugin {
  const limit = options.limit ?? 5;
  const byName = new Map(options.catalog.map((tool) => [tool.name, tool]));
  const documents = options.catalog.map((tool) => `${tool.name} ${tool.name} ${tool.description}`);

  const toolSearch: Tool = {
    name: "tool_search",
    description: SEARCH_DESCRIPTION,
    parameters: { type: "object", properties: { query: { type: "string", description: "What you want to do" } }, required: ["query"] },
    effect: "read",
    async execute(args) {
      const query = typeof (args as { query?: unknown })?.query === "string" ? (args as { query: string }).query : "";
      if (query.trim() === "") return text("'query' must be a non-empty string.", true);
      const matches = rank(documents, query).slice(0, limit);
      if (matches.length === 0) return text(`No tool matches '${query}'. Try other words.`);
      const lines = matches.map(({ index }) => {
        const tool = options.catalog[index]!;
        return `${tool.name}: ${tool.description}\nparameters: ${JSON.stringify(tool.parameters)}`;
      });
      return text(lines.join("\n\n"));
    },
  };

  const toolCall: Tool = {
    name: "tool_call",
    description: CALL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Name of the tool" }, args: { type: "object", description: "Arguments for the tool" } },
      required: ["name"],
    },
    effect: "exec",
    replay: "never",
    async execute(args, context) {
      const input = (typeof args === "object" && args !== null ? args : {}) as { name?: unknown; args?: unknown };
      if (typeof input.name !== "string") return text("'name' must be a string.", true);
      const tool = byName.get(input.name);
      if (!tool) return text(`There is no tool named '${input.name}'. Use tool_search to find one.`, true);
      return tool.execute(input.args ?? {}, context);
    },
  };

  return {
    name: "search",
    compensates: "a long list of tool declarations fills every request and confuses the model",
    setup: (api) => void [api.registerTool(toolSearch), api.registerTool(toolCall)],
  };
}
