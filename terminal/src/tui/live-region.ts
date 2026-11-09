// The bottom part of the screen that is redrawn in place (working indicator, prompt, status line), while finished
// output is printed above it and stays in the terminal's own scrollback. No alternate screen, so the user can scroll
// back and select text as in any shell.

export interface OutputStream {
  write(data: string): unknown;
  columns?: number;
  rows?: number;
}

export interface LiveCursor {
  row: number;
  col: number;
}

export interface LiveRegion {
  /** Writes finished lines above the live area. */
  print(lines: string[]): void;
  /** Replaces the live area. `cursor` is where the text cursor goes inside it. */
  setLive(lines: string[], cursor: LiveCursor): void;
  /** Removes the live area from the screen (before exit, or before another program writes). */
  clear(): void;
  /** Forgets what is on the screen without erasing it (after the screen was cleared by someone else). */
  forget(): void;
  width(): number;
}

const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";

export function createLiveRegion(out: OutputStream): LiveRegion {
  let live: string[] = [];
  let cursor: LiveCursor = { row: 0, col: 0 };
  let drawn = false;

  /** Moves from the text cursor back to the first column of the first live line and erases down. */
  const eraseCommand = () => (drawn ? `${cursor.row > 0 ? `\u001b[${cursor.row}A` : ""}\r\u001b[J` : "");

  function paintCommand(): string {
    if (live.length === 0) return "";
    const lastRow = live.length - 1;
    const up = lastRow - cursor.row;
    return `${live.join("\n")}${up > 0 ? `\u001b[${up}A` : ""}\r${cursor.col > 0 ? `\u001b[${cursor.col}C` : ""}`;
  }

  const emit = (text: string) => out.write(`${SYNC_BEGIN}${text}${SYNC_END}`);

  return {
    print(lines) {
      if (lines.length === 0) return;
      emit(`${eraseCommand()}${lines.map((line) => `${line}\n`).join("")}${paintCommand()}`);
      drawn = live.length > 0;
    },
    setLive(lines, nextCursor) {
      const erase = eraseCommand();
      live = lines;
      cursor = nextCursor;
      emit(`${erase}${paintCommand()}`);
      drawn = live.length > 0;
    },
    clear() {
      emit(eraseCommand());
      live = [];
      cursor = { row: 0, col: 0 };
      drawn = false;
    },
    forget() {
      drawn = false;
      live = [];
      cursor = { row: 0, col: 0 };
    },
    width: () => out.columns ?? 80,
  };
}
