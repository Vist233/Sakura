// What the live area looks like for a given state: progress above, the prompt box, the status line and a popup under it.
// Pure: state in, lines and cursor position out.
import { createPalette, truncate, wrapAnsi } from "../ansi.ts";
import { sessionLabel } from "../session-store.ts";
import type { SessionMeta } from "../session-store.ts";
import type { SlashCommand } from "../slash-commands.ts";
import type { PendingMessage } from "../run-driver.ts";
import type { ToolBlock } from "../transcript.ts";
import type { Layout } from "./line-editor.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT = "› ";

export interface PickerState {
  title: string;
  items: SessionMeta[];
  index: number;
}

export interface ScreenState {
  width: number;
  color: boolean;
  composer: Layout;
  statusLine: string;
  working: boolean;
  elapsedSeconds: number;
  frame: number;
  runningTools: ToolBlock[];
  streamingTail: string;
  /** Reasoning text arriving now; only its end is shown, on one line. */
  reasoning: string;
  pending: readonly PendingMessage[];
  popup: { commands: SlashCommand[]; index: number } | undefined;
  picker: PickerState | undefined;
  hint: string | undefined;
}

export interface LiveView {
  lines: string[];
  cursor: { row: number; col: number };
}

export function composeLive(state: ScreenState): LiveView {
  const pal = createPalette(state.color);
  const width = Math.max(20, state.width);
  const lines: string[] = [];

  if (state.streamingTail.trim() !== "") {
    const tail = wrapAnsi(state.streamingTail.replace(/\s+$/, ""), width - 2).slice(-2);
    for (const line of tail) lines.push(truncate(pal.dim(`  ${line}`), width));
  }
  if (state.reasoning.trim() !== "") lines.push(truncate(pal.dim(`  thinking: …${state.reasoning.replace(/\s+/g, " ").trim().slice(-Math.max(10, width - 16))}`), width));
  const spinner = SPINNER[state.frame % SPINNER.length]!;
  for (const tool of state.runningTools.slice(-3)) lines.push(truncate(`${pal.cyan(spinner)} ${pal.bold(tool.name)} ${tool.summary}`, width));
  if (state.working) lines.push(truncate(pal.dim(`${spinner} Working (${state.elapsedSeconds}s) · Esc to cancel · Enter to steer · Tab to queue`), width));
  for (const message of state.pending.slice(-3)) lines.push(truncate(pal.dim(`  ↳ ${message.kind === "steer" ? "steering" : "queued"}: ${message.text.replace(/\s+/g, " ")}`), width));
  if (state.hint) lines.push(truncate(pal.yellow(state.hint), width));

  if (state.picker) {
    const { picker } = state;
    lines.push(pal.dim("─".repeat(width)));
    lines.push(pal.bold(picker.title) + pal.dim("  ↑/↓ choose · Enter open · Esc cancel"));
    const first = Math.max(0, Math.min(picker.index - 3, picker.items.length - 8));
    for (let index = first; index < Math.min(picker.items.length, first + 8); index += 1) {
      const item = picker.items[index]!;
      const when = new Date(item.updatedAt).toISOString().slice(0, 16).replace("T", " ");
      const row = `${index === picker.index ? "›" : " "} ${when}  ${item.id.slice(0, 8)}  ${sessionLabel(item)}`;
      lines.push(truncate(index === picker.index ? pal.cyan(row) : row, width));
    }
    return { lines, cursor: { row: lines.length - 1, col: 0 } };
  }

  lines.push(pal.dim("─".repeat(width)));
  const composerTop = lines.length;
  state.composer.rows.forEach((row, index) => lines.push(`${index === 0 ? pal.bold(pal.cyan(PROMPT)) : "  "}${row}`));
  const cursor = { row: composerTop + state.composer.cursorRow, col: PROMPT.length + state.composer.cursorCol };
  lines.push(pal.dim(truncate(` ${state.statusLine}`, width)));
  if (state.popup) {
    const { commands, index } = state.popup;
    const first = Math.max(0, Math.min(index - 2, commands.length - 6));
    for (let position = first; position < Math.min(commands.length, first + 6); position += 1) {
      const command = commands[position]!;
      const row = `${position === index ? "›" : " "} /${command.name.padEnd(12)} ${command.summary}`;
      lines.push(truncate(position === index ? pal.cyan(row) : pal.dim(row), width));
    }
  }
  return { lines, cursor };
}
