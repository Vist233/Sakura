// The slash commands a client can offer in its "/" menu and that work inside a prompt. Pure.
import type { AvailableCommand } from "./types.ts";

export const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
  { name: "compact", description: "Summarise the conversation so far to free context" },
  { name: "status", description: "Show the session, model, permissions, context and token usage" },
]);

export type SlashCommand = "compact" | "status";

/** `/compact` or `/status` on their own (surrounding space allowed). Anything else, including other slash commands, is an ordinary prompt. */
export function parseCommand(prompt: string): SlashCommand | undefined {
  const match = /^\/(compact|status)\s*$/.exec(prompt.trim());
  return match ? (match[1] as SlashCommand) : undefined;
}
