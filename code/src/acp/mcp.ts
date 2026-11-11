// MCP servers a client lists in `session/new` and `session/load`, as the framework's server definitions. Pure.
// The `env` values of a server are credentials: nothing here logs or returns them anywhere but in the definition itself.
import type { McpServerDefinition } from "../config.ts";

export interface ClientMcpServers {
  servers: Record<string, McpServerDefinition>;
  /** Servers left out: not a command to run (the agent advertises no HTTP or SSE support), or without a usable name or command. */
  skipped: number;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Tool names are `mcp__<server>__<tool>`, so a server name keeps letters, digits, `_` and `-`. */
export const serverName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export function clientMcpServers(list: unknown): ClientMcpServers {
  const servers: Record<string, McpServerDefinition> = {};
  let skipped = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const item = record(raw);
    const stdio = item.type === undefined || item.type === "stdio";
    const name = typeof item.name === "string" ? serverName(item.name) : "";
    if (!stdio || name === "" || typeof item.command !== "string" || item.command === "") {
      skipped += 1;
      continue;
    }
    const args = Array.isArray(item.args) ? item.args.filter((arg): arg is string => typeof arg === "string") : [];
    const env: Record<string, string> = {};
    for (const entry of Array.isArray(item.env) ? item.env : []) {
      const variable = record(entry);
      if (typeof variable.name === "string" && variable.name !== "" && typeof variable.value === "string") env[variable.name] = variable.value;
    }
    let unique = name;
    for (let n = 2; unique in servers; n++) unique = `${name}-${n}`;
    servers[unique] = { command: item.command, ...(args.length > 0 ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) };
  }
  return { servers, skipped };
}
