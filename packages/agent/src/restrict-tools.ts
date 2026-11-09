import type { Plugin } from "@sakura/kernel";

/**
 * The plugins as a sub-agent with a limited tool list sees them: a tool a plugin registers is kept only if its name is on the list, the same rule
 * that applies to the built-in tools. Everything else about the plugins stays as it is.
 */
export function restrictTools(plugins: readonly Plugin[], allowed: readonly string[]): Plugin[] {
  const names = new Set(allowed);
  return plugins.map((plugin) => ({
    ...plugin,
    setup: (api) => plugin.setup({ ...api, registerTool: (tool) => (names.has(tool.name) ? api.registerTool(tool) : undefined) }),
  }));
}
