// The slash commands a client can offer in its "/" menu and that work inside a prompt. Pure.
import type { AvailableCommand } from "./types.ts";

export const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
  { name: "compact", description: "Summarise the conversation so far to free context" },
  { name: "status", description: "Show the session, model, permissions, context and token usage" },
  { name: "goal", description: "Show, set or clear the goal of this session; the agent is checked against it before it may stop", input: { hint: "objective, or clear" } },
]);

export type ParsedCommand =
  | { name: "compact" }
  | { name: "status" }
  /** `/goal` alone shows the goal; `/goal clear` (or `off`) ends it; `/goal <text>` sets it and starts working on it. */
  | { name: "goal"; action: "show" }
  | { name: "goal"; action: "clear" }
  | { name: "goal"; action: "set"; objective: string };

/** The commands above, written on their own line. Anything else, including other slash commands, is an ordinary prompt. */
export function parseCommand(prompt: string): ParsedCommand | undefined {
  const text = prompt.trim();
  if (/^\/compact$/.test(text)) return { name: "compact" };
  if (/^\/status$/.test(text)) return { name: "status" };
  const goal = /^\/goal(?:\s+([\s\S]+))?$/.exec(text);
  if (!goal) return undefined;
  const argument = goal[1]?.trim() ?? "";
  if (argument === "") return { name: "goal", action: "show" };
  if (/^(clear|off)$/i.test(argument)) return { name: "goal", action: "clear" };
  return { name: "goal", action: "set", objective: argument };
}
