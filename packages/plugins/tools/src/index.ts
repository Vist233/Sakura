import type { Tool } from "@sakura/kernel";
import { createBashTool } from "./builtin/bash.ts";
import type { BashOptions } from "./builtin/bash.ts";
import { editTool } from "./builtin/edit.ts";
import { readTool } from "./builtin/read.ts";
import { writeTool } from "./builtin/write.ts";

type Names = "read" | "write" | "edit" | "bash";

export interface BuiltinOptions {
  bash?: BashOptions;
}

/** The default tool set: read, write, edit, bash. */
export function builtinTools(names: ReadonlyArray<Names> = ["read", "write", "edit", "bash"], options: BuiltinOptions = {}): Tool[] {
  const all: Record<Names, Tool> = { read: readTool, write: writeTool, edit: editTool, bash: createBashTool(options.bash) };
  return names.map((name) => all[name]);
}

export { toolsPlugin } from "./artifacts.ts";
export type { FoldRule, ToolsPluginOptions } from "./artifacts.ts";
