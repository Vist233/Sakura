// The status line under the prompt: model, effort, directory and how much context is left (the Codex layout).
import { createPalette, displayWidth, truncate } from "./ansi.ts";

export interface StatusInfo {
  provider: string;
  model: string;
  thinking: string | undefined;
  cwd: string;
  home: string | undefined;
  /** Percent of the context window still free; undefined before the first measurement. */
  contextLeftPercent: number | undefined;
  /** The percentage is an estimate (after a compaction, until the next reply reports usage); shown with a "~". */
  contextEstimated?: boolean;
  permissions: string;
  /** A mode asked for with Shift+Tab during a run; it takes effect when the run ends. */
  pendingPermissions?: string | undefined;
  redaction: boolean;
  working: boolean;
  queued: number;
  /** Scheduled jobs that are active; shown only when there is one. */
  scheduled?: number;
}

export function shortenPath(path: string, home: string | undefined, width: number): string {
  const display = home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  if (display.length <= width) return display;
  const parts = display.split("/");
  const tail = parts.slice(-2).join("/");
  return `…/${tail}`.length <= width ? `…/${tail}` : `…${display.slice(-(width - 1))}`;
}

export function contextLeftPercent(free: number, window: number): number {
  return window <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((free / window) * 100)));
}

function contextText(info: StatusInfo, pal: ReturnType<typeof createPalette>): string {
  const text = `${info.contextEstimated ? "~" : ""}${info.contextLeftPercent}%`;
  return (info.contextLeftPercent ?? 100) < 15 ? pal.red(text) : text;
}

function permissionsPiece(info: StatusInfo, pal: ReturnType<typeof createPalette>): string {
  const mode = info.pendingPermissions ?? info.permissions;
  const paint = mode === "auto" ? pal.dim : mode === "full-access" ? pal.red : pal.yellow;
  return info.pendingPermissions === undefined ? paint(mode) : paint(mode) + pal.dim(" (next turn)");
}

export function formatStatusLine(info: StatusInfo, width: number, color: boolean): string {
  const pal = createPalette(color);
  const pieces = [
    pal.bold(info.model) + (info.thinking ? pal.dim(` ${info.thinking}`) : ""),
    info.contextLeftPercent === undefined ? "" : `${contextText(info, pal)} context left`,
    permissionsPiece(info, pal),
    info.redaction ? pal.magenta("redaction") : "",
    info.queued > 0 ? pal.cyan(`${info.queued} queued`) : "",
    info.scheduled ? pal.cyan(`⏰ ${info.scheduled}`) : "",
    shortenPath(info.cwd, info.home, Math.max(12, Math.floor(width / 3))),
  ].filter((piece) => piece !== "");
  const line = pieces.join(pal.dim(" · "));
  return displayWidth(line) > width ? truncate(line, width) : line;
}
