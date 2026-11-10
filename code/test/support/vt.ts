// A tiny terminal emulator for tests: interprets the escape sequences this application writes and keeps the screen.
// Rows that scroll off are kept in `scrollback`, so a test can check both what the user sees and what stays in the history.
import { displayWidth } from "../../src/ansi.ts";

export class VirtualTerminal {
  readonly columns: number;
  /** With a height the terminal scrolls: `rows` keeps the history, the last `height` rows are the screen. */
  readonly height: number | undefined;
  /** Index in `rows` of the first row of the screen (always 0 without a height). */
  top = 0;
  rows: string[][] = [[]];
  row = 0;
  col = 0;
  styled = false;
  private pending = "";

  constructor(columns = 80, height?: number) {
    this.columns = columns;
    this.height = height;
  }

  /** The rows the user sees now: the last `height` rows, blank rows included. */
  screen(): string[] {
    const lines = this.lines();
    const height = this.height ?? lines.length;
    return Array.from({ length: height }, (_, index) => lines[this.top + index] ?? "");
  }

  private lineFeed() {
    this.row += 1;
    this.col = 0;
    while (this.rows.length <= this.row) this.rows.push([]);
    if (this.height !== undefined && this.row - this.top >= this.height) this.top = this.row - this.height + 1;
  }

  write(data: string): boolean {
    const text = this.pending + data;
    this.pending = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\u001b") {
        const rest = text.slice(index);
        const csi = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(rest);
        if (csi) {
          this.csi(csi[1]!, csi[2]!);
          index += csi[0].length;
          continue;
        }
        const osc = /^\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(rest);
        if (osc) {
          index += osc[0].length;
          continue;
        }
        if (rest.length < 12 && !/\u001b[\[\]][\s\S]*[A-Za-z\\\u0007]/.test(rest)) {
          this.pending = rest;
          return true;
        }
        index += 1;
        continue;
      }
      if (char === "\n") this.lineFeed();
      else if (char === "\r") this.col = 0;
      else {
        const cp = String.fromCodePoint(text.codePointAt(index)!);
        index += cp.length - 1;
        this.put(cp);
      }
      index += 1;
    }
    return true;
  }

  private put(char: string) {
    const width = displayWidth(char);
    if (width === 0) return;
    if (this.col + width > this.columns) this.lineFeed();
    const line = this.rows[this.row]!;
    while (line.length < this.col) line.push(" ");
    line[this.col] = char;
    if (width === 2) line[this.col + 1] = "";
    this.col += width;
  }

  private csi(params: string, final: string) {
    const n = Number.parseInt(params, 10);
    const amount = Number.isNaN(n) ? 1 : n;
    if (final === "A") this.row = Math.max(this.top, this.row - amount);
    else if (final === "B") {
      this.row = Math.min(this.row + amount, this.height === undefined ? Infinity : this.top + this.height - 1);
      while (this.rows.length <= this.row) this.rows.push([]);
    } else if (final === "C") this.col += amount;
    else if (final === "D") this.col = Math.max(0, this.col - amount);
    else if (final === "G") this.col = Math.max(0, amount - 1);
    else if (final === "J") {
      if (params === "" || params === "0") {
        this.rows[this.row] = (this.rows[this.row] ?? []).slice(0, this.col);
        this.rows.length = this.row + 1;
      } else if (params === "2" || params === "3") {
        this.rows = [[]];
        this.row = 0;
        this.col = 0;
      }
    } else if (final === "K") {
      const line = this.rows[this.row] ?? [];
      if (params === "" || params === "0") this.rows[this.row] = line.slice(0, this.col);
      else if (params === "2") this.rows[this.row] = [];
    } else if (final === "H") {
      this.row = 0;
      this.col = 0;
    }
  }

  /** The text of every row, trailing spaces removed. */
  lines(): string[] {
    return this.rows.map((line) => line.join("").replace(/\s+$/, ""));
  }

  text(): string {
    return this.lines().join("\n").replace(/\n+$/, "");
  }
}
