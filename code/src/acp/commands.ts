// The slash commands a client can offer in its "/" menu and that work inside a prompt. Pure. Commands that only ask the agent to do
// something (`/review`, `/init`) become a prompt, with the same wording as in the terminal; the others are handled by the agent.
import { INIT_PROMPT, reviewPrompt } from "../slash-commands.ts";
import type { AvailableCommand } from "./types.ts";

export const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
  { name: "compact", description: "Summarise the conversation so far to free context" },
  { name: "status", description: "Show the session, model, permissions, context and token usage" },
  { name: "goal", description: "Show, set or clear the goal of this session; the agent is checked against it before it may stop", input: { hint: "objective, or clear" } },
  { name: "undo", description: "Go back to before your last message (the message is shown again so you can send it changed)" },
  { name: "fork", description: "Copy this session into a new one (the original stays as it is)" },
  { name: "review", description: "Have the agent review the uncommitted changes", input: { hint: "what to focus on" } },
  { name: "init", description: "Have the agent write an AGENTS.md for this project" },
  { name: "mcp", description: "Show the MCP servers and whether they connected" },
  { name: "loop", description: "Run a prompt again and again while the session is open; alone: list the jobs; stop, pause or resume a job", input: { hint: "10m check the build, or stop [id]" } },
  { name: "in", description: "Run a prompt once, later (the session must stay open)", input: { hint: "20m look at the deploy" } },
]);

export type ParsedCommand =
  | { name: "compact" | "status" | "undo" | "fork" | "mcp" }
  /** `/goal` alone shows the goal; `/goal clear` (or `off`) ends it; `/goal <text>` sets it and starts working on it. */
  | { name: "goal"; action: "show" }
  | { name: "goal"; action: "clear" }
  | { name: "goal"; action: "set"; objective: string }
  /** `/loop ...` and `/in ...` (see schedule.ts); the arguments are as typed. */
  | { name: "schedule"; command: "loop" | "in"; args: string }
  /** A command that is a prompt for the agent. */
  | { name: "prompt"; text: string };

/** The commands above, written on their own line. Anything else, including other slash commands, is an ordinary prompt. */
export function parseCommand(prompt: string): ParsedCommand | undefined {
  const text = prompt.trim();
  const plain = /^\/(compact|status|undo|fork|mcp)$/.exec(text);
  if (plain) return { name: plain[1] as "compact" | "status" | "undo" | "fork" | "mcp" };
  const schedule = /^\/(loop|in)(?:\s+([\s\S]*))?$/.exec(text);
  if (schedule) return { name: "schedule", command: schedule[1] as "loop" | "in", args: schedule[2] ?? "" };
  if (/^\/init$/.test(text)) return { name: "prompt", text: INIT_PROMPT };
  const review = /^\/review(?:\s+([\s\S]+))?$/.exec(text);
  if (review) return { name: "prompt", text: reviewPrompt({ focus: review[1]?.trim() ?? "" }) };
  const goal = /^\/goal(?:\s+([\s\S]+))?$/.exec(text);
  if (!goal) return undefined;
  const argument = goal[1]?.trim() ?? "";
  if (argument === "") return { name: "goal", action: "show" };
  if (/^(clear|off)$/i.test(argument)) return { name: "goal", action: "clear" };
  return { name: "goal", action: "set", objective: argument };
}
