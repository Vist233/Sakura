import type { Content, Environment, Plugin, ToolResult } from "@sakura/kernel";
import { foldHead, foldTail } from "./fold.ts";
import type { FoldLimits } from "./fold.ts";

export interface FoldRule extends FoldLimits {
  /** Which part of a long output stays in the preview. */
  keep: "head" | "tail" | "both";
}

export interface ToolsPluginOptions {
  /** Limits for tools that have no rule of their own. Default: head and tail, 2000 lines or 50 KB. */
  default?: FoldRule;
  /** Rules by tool name (for example a 20 KB head-and-tail rule for an MCP tool). */
  rules?: Record<string, FoldRule>;
  /** Tools that already shorten their own output. Default: read, write, edit, bash. */
  skip?: string[];
  /** Where full outputs are saved inside the environment. Default .sakura/artifacts. */
  directory?: string;
}

const DEFAULT_RULE: FoldRule = { keep: "both", maxLines: 2000, maxBytes: 50 * 1024 };
const textOf = (content: Content[]): string => content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** A short version of `text` that follows the rule, or undefined when it already fits. */
export function preview(text: string, rule: FoldRule): { text: string; totalLines: number } | undefined {
  const head = foldHead(text, rule);
  const totalLines = head.totalLines;
  if (!head.truncated && Buffer.byteLength(text, "utf8") <= rule.maxBytes) return undefined;
  if (rule.keep === "head") return { text: head.text, totalLines };
  if (rule.keep === "tail") return { text: foldTail(text, rule).text, totalLines };
  const half = { maxLines: Math.max(1, Math.floor(rule.maxLines / 2)), maxBytes: Math.max(1, Math.floor(rule.maxBytes / 2)) };
  const start = foldHead(text, half);
  const end = foldTail(text, half);
  const omitted = Math.max(0, totalLines - start.shownLines - end.shownLines);
  return { text: `${start.text}\n[... ${omitted} lines left out ...]\n${end.text}`, totalLines };
}

/**
 * The shared part of the tools: when any tool returns more than the limit, the full output is saved as a file
 * in the environment and the model gets a short preview that says where the file is. The conversation stays small;
 * the agent reads the file in pieces if it needs more. Images are left alone.
 */
export function toolsPlugin(options: ToolsPluginOptions = {}): Plugin {
  const skip = new Set(options.skip ?? ["read", "write", "edit", "bash"]);
  const directory = options.directory ?? ".sakura/artifacts";
  let env: Environment | undefined;

  return {
    name: "tools",
    compensates: "models cannot cope with unlimited tool output",
    async prepare(context) {
      env = context.env; // the plugin is set up once, but the environment is only known when a run starts
    },
    setup(api) {
      api.on("tool.run", async (call, next): Promise<ToolResult> => {
        const result = await next();
        if (skip.has(call.name)) return result;
        const rule = options.rules?.[call.name] ?? options.default ?? DEFAULT_RULE;
        const full = textOf(result.content);
        const short = preview(full, rule);
        if (!short) return result;

        let where = "";
        if (env) {
          const path = `${directory}/${call.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`;
          try {
            await env.writeFile(path, full);
            where = ` The full output (${short.totalLines} lines) is saved in ${path}; use read with offset and limit to look at the part you need.`;
          } catch {
            where = " The rest could not be saved.";
          }
        }
        const images = result.content.filter((part) => part.type === "image");
        return { ...result, content: [{ type: "text", text: `${short.text}\n\n[The output was too long to show in full.${where}]` }, ...images] };
      });
    },
  };
}
