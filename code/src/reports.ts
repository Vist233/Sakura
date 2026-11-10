// Text reports shown by slash commands (/status, /model, /permissions, /mcp, /help), as Markdown. Pure functions.
import type { Agent, ContextStatus, GoalRecord, LogEntry, UsageTotals } from "./framework.ts";
import { PERMISSION_NAMES, PERMISSION_PRESETS } from "./permissions.ts";
import type { PermissionName } from "./permissions.ts";
import type { ProviderListing } from "./providers.ts";

const number = (value: number) => value.toLocaleString("en-US");

/** Token counts the short way (12.3k, 6.40M), as the mature tools print them. */
export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** The share of one reply's input that came from the cache: cache read / (cache read + new input + cache write). */
function replyHitRate(usage: { input: number; cacheRead: number; cacheWrite: number }): number | undefined {
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return total > 0 ? usage.cacheRead / total : undefined;
}

/** The middle one of the per-reply cache hit rates of the model replies in a log (compaction and goal-check requests are not replies). */
export function medianReplyHitRate(entries: readonly LogEntry[]): number | undefined {
  const rates: number[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.usage) continue;
    const rate = replyHitRate(entry.message.usage);
    if (rate !== undefined) rates.push(rate);
  }
  if (rates.length === 0) return undefined;
  rates.sort((a, b) => a - b);
  const middle = Math.floor(rates.length / 2);
  return rates.length % 2 === 1 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2;
}

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

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
  /** One sentence on idle auto-compaction, for example "after 5 min idle, from 20,000 tokens" or "off". */
  idleCompaction: string;
  /** See medianReplyHitRate; undefined before the first reply. */
  medianHitRate?: number | undefined;
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
    ...usageRows(input),
    ["Goal", input.goal ? `${input.goal.status}: ${input.goal.objective}` : "none"],
    ["Idle compaction", input.idleCompaction],
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

/**
 * Token use in the shape of the mature tools: the whole input with the cached part named (as Claude Code's /usage does),
 * the cache hit rate (as its "Prompt cache" line does), the output, and the replies they belong to.
 */
function usageRows(input: StatusReportInput): Array<[string, string]> {
  const { usage } = input;
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const written = usage.cacheWrite > 0 ? `, ${tokens(usage.cacheWrite)} written to the cache` : "";
  const hit = totalInput > 0 ? `${percent(usage.cacheRead / totalInput)} of input tokens from the cache${input.medianHitRate === undefined ? "" : `; median reply ${percent(input.medianHitRate)}`}` : "no requests yet";
  return [
    ["Input", totalInput > 0 ? `${tokens(totalInput)} tokens: ${tokens(usage.cacheRead)} cached, ${tokens(usage.input)} new${written}` : "none yet"],
    ["Cache hit rate", `${hit} (${number(usage.turns)} replies; compaction and goal checks included in the totals, review requests not counted)`],
    ["Output", `${tokens(usage.output)} tokens`],
  ];
}
