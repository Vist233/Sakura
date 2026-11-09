// Text reports shown by slash commands (/status, /model, /permissions, /mcp, /help), as Markdown. Pure functions.
import type { Agent, ContextStatus, GoalRecord, UsageTotals } from "./framework.ts";
import { PERMISSION_NAMES, PERMISSION_PRESETS } from "./permissions.ts";
import type { PermissionName } from "./permissions.ts";
import type { ProviderListing } from "./providers.ts";

const number = (value: number) => value.toLocaleString("en-US");

export interface StatusReportInput {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  provider: string;
  model: string;
  thinking: string | undefined;
  permissions: PermissionName;
  redaction: boolean;
  context: ContextStatus;
  usage: UsageTotals;
  goal: GoalRecord | undefined;
  working: boolean;
}

export function statusReport(input: StatusReportInput): string {
  const free = input.context.window > 0 ? Math.round((input.context.free / input.context.window) * 100) : 0;
  const rows: Array<[string, string]> = [
    ["Session", `\`${input.sessionId}\``],
    ["Session file", `\`${input.sessionFile}\``],
    ["Directory", `\`${input.cwd}\` (not restricted: the agent may go anywhere)`],
    ["Model", `${input.model} via ${input.provider}${input.thinking ? `, thinking ${input.thinking}` : ""}`],
    ["Permissions", `${input.permissions}: ${PERMISSION_PRESETS[input.permissions].summary}`],
    ["Redaction", input.redaction ? "on" : "off"],
    ["Context", `${number(input.context.tokens)} of ${number(input.context.window)} tokens used, ${free}% left${input.context.compactAt ? `, compacts at ${number(input.context.compactAt)}` : ""}`],
    ["Usage", `${number(input.usage.input)} in, ${number(input.usage.output)} out, ${number(input.usage.cacheRead)} cached, ${input.usage.turns} replies`],
    ["Goal", input.goal ? `${input.goal.status}: ${input.goal.objective}` : "none"],
    ["State", input.working ? "working" : "idle"],
  ];
  return ["| Item | Value |", "|---|---|", ...rows.map(([key, value]) => `| **${key}** | ${value} |`)].join("\n");
}

export function modelsReport(listings: ProviderListing[], current: { provider: string; model: string }): string {
  const rows = listings.map((entry) => {
    const here = entry.name === current.provider;
    return `| ${here ? "▶ " : ""}\`${entry.name}\` | ${here ? current.model : entry.definition.model} | \`${entry.definition.keyEnv}\` ${entry.keyPresent ? "set" : "**not set**"} |`;
  });
  return ["| Provider | Model | Key |", "|---|---|---|", ...rows, "", "Switch with `/model <provider>` or `/model <provider> <model>`."].join("\n");
}

export function permissionsReport(current: PermissionName, redaction: boolean): string {
  const rows = PERMISSION_NAMES.map((name) => `| ${name === current ? "▶ " : ""}\`${name}\` | ${PERMISSION_PRESETS[name].summary} |`);
  return ["| Preset | Meaning |", "|---|---|", ...rows, "", `Redaction is **${redaction ? "on" : "off"}** (\`/redaction on\`). The working directory is never restricted.`].join("\n");
}

export function mcpReport(status: Agent["mcp"]): string {
  const names = Object.keys(status);
  if (names.length === 0) return "No MCP servers are configured. Add them under `[mcp.servers.NAME]` in the config file.";
  return ["| Server | State | Tools |", "|---|---|---|", ...names.map((name) => `| \`${name}\` | ${status[name]!.ok ? "connected" : `failed: ${status[name]!.error ?? "unknown"}`} | ${status[name]!.toolCount} |`)].join("\n");
}
