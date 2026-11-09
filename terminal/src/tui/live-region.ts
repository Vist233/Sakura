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
  /** Forgets what is on the screen without erasing it (after a resize, when its shape is unknown). */
  forget(): void;
  /** The screen was emptied: the next output starts at the top. */
  cleared(): void;
  width(): number;
}

const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";

export interface LiveRegionOptions {
  /**
   * Keep the live area on the last rows of the screen even when little has been printed yet: blank rows are left
   * between the output and the live area, and printed lines fill them. Plain newlines only, no scroll region, so
   * the terminal's own scrollback keeps working everywhere.
   */
  pinned?: boolean;
}

export function createLiveRegion(out: OutputStream, options: LiveRegionOptions = {}): LiveRegion {
  let live: string[] = [];
  let cursor: LiveCursor = { row: 0, col: 0 };
  let drawn = false;
  /** Blank rows between the last printed line and the live area. */
  let gap = 0;
  /** Rows of printed output since the screen was empty (capped at the screen height). */
  let contentRows = 0;

  const screenRows = () => out.rows ?? 0;
  const wantedGap = () => (options.pinned && screenRows() > 0 ? Math.max(0, screenRows() - contentRows - live.length) : 0);

  /** Moves from the text cursor back to the first column of the end of the printed output and erases down. */
  const eraseCommand = () => {
    if (!drawn) return "";
    const up = cursor.row + gap;
    return `${up > 0 ? `\u001b[${up}A` : ""}\r\u001b[J`;
  };

  function paintCommand(): string {
    if (live.length === 0) {
      gap = 0;
      return "";
    }
    gap = wantedGap();
    const lastRow = live.length - 1;
    const up = lastRow - cursor.row;
    return `${"\n".repeat(gap)}${live.join("\n")}${up > 0 ? `\u001b[${up}A` : ""}\r${cursor.col > 0 ? `\u001b[${cursor.col}C` : ""}`;
  }

  const emit = (text: string) => out.write(`${SYNC_BEGIN}${text}${SYNC_END}`);

  return {
    print(lines) {
      if (lines.length === 0) return;
      const erase = eraseCommand();
      contentRows = Math.min(contentRows + lines.length, Math.max(screenRows(), 1));
      emit(`${erase}${lines.map((line) => `${line}\n`).join("")}${paintCommand()}`);
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
      gap = 0;
    },
    forget() {
      // after a resize or a screen clear what is on the screen is unknown: carry on from the cursor, without padding
      drawn = false;
      live = [];
      cursor = { row: 0, col: 0 };
      gap = 0;
      contentRows = Math.max(screenRows(), 1);
    },
    cleared() {
      this.forget();
      contentRows = 0;
    },
    width: () => out.columns ?? 80,
  };
}
