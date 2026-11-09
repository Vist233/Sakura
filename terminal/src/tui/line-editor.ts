// The text of the prompt: a buffer with a cursor, multi-line editing, history and the usual readline keys. Pure state; no output.
import { displayWidth } from "../ansi.ts";
import type { KeyEvent } from "./keys.ts";

export type EditAction = "none" | "submit" | "tab" | "shift-tab" | "escape" | "interrupt" | "eof" | "page-up" | "page-down";

export interface Layout {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

export interface LineEditor {
  handle(key: KeyEvent): EditAction;
  /** The text as shown in the composer (a big paste appears as a placeholder). */
  value(): string;
  /** The text to send: every placeholder replaced by the paste it stands for. */
  expanded(): string;
  cursor(): number;
  set(text: string): void;
  clear(): void;
  /** Remembers a submitted line for the up arrow. */
  remember(text: string): void;
  /** The text cut into rows of at most `width` columns, and where the cursor is among them. */
  layout(width: number): Layout;
}

/** A paste longer than this many characters, or with more lines, is shown as a placeholder (the limit Codex uses, plus a line limit). */
export const PASTE_FOLD_CHARS = 1000;
export const PASTE_FOLD_LINES = 5;

/** Placeholder of the n-th paste of a size, in Codex's wording: "[Pasted Content 1234 chars]", then "… chars #2". */
function placeholderFor(chars: number, taken: Map<string, string>): string {
  const base = `[Pasted Content ${chars} chars`;
  let label = `${base}]`;
  for (let copy = 2; taken.has(label); copy += 1) label = `${base} #${copy}]`;
  return label;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (entry) => entry.segment);
}

export function createLineEditor(): LineEditor {
  let text = "";
  let cursor = 0; // index into `text` in UTF-16 units, always on a grapheme boundary
  let historyIndex: number | undefined;
  let draft = "";
  let killed = "";
  /** placeholder -> the pasted text it stands for; every key occurs in `text` */
  let pastes = new Map<string, string>();
  let draftPastes = new Map<string, string>();
  const history: Array<{ text: string; pastes: Map<string, string> }> = [];

  /** Where a placeholder starts that contains position `at` strictly inside, else `at`. */
  const snapToStart = (at: number) => {
    for (const key of pastes.keys()) for (let from = text.indexOf(key); from !== -1; from = text.indexOf(key, from + 1)) if (at > from && at < from + key.length) return from;
    return at;
  };
  const snapToEnd = (at: number) => {
    for (const key of pastes.keys()) for (let from = text.indexOf(key); from !== -1; from = text.indexOf(key, from + 1)) if (at > from && at < from + key.length) return from + key.length;
    return at;
  };
  const prune = () => {
    for (const key of pastes.keys()) if (!text.includes(key)) pastes.delete(key);
  };
  /** Text that is too big for the composer, as a placeholder that remembers it. */
  const fold = (value: string): string => {
    if (value.length <= PASTE_FOLD_CHARS && value.split("\n").length <= PASTE_FOLD_LINES) return value;
    const label = placeholderFor(value.length, pastes);
    pastes.set(label, value);
    return label;
  };

  const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = (at: number) => {
    const found = text.indexOf("\n", at);
    return found === -1 ? text.length : found;
  };
  const previousBoundary = (at: number) => {
    const before = graphemes(text.slice(0, at));
    return snapToStart(at - (before[before.length - 1]?.length ?? 0));
  };
  const nextBoundary = (at: number) => snapToEnd(at + (graphemes(text.slice(at))[0]?.length ?? 0));

  const isWordChar = (char: string) => /[\p{L}\p{N}_]/u.test(char);
  function wordLeft(at: number): number {
    let position = at;
    while (position > 0 && !isWordChar(text[position - 1]!)) position -= 1;
    while (position > 0 && isWordChar(text[position - 1]!)) position -= 1;
    return snapToStart(position);
  }
  function wordRight(at: number): number {
    let position = at;
    while (position < text.length && !isWordChar(text[position]!)) position += 1;
    while (position < text.length && isWordChar(text[position]!)) position += 1;
    return snapToEnd(position);
  }

  const insert = (value: string) => {
    text = text.slice(0, cursor) + value + text.slice(cursor);
    cursor += value.length;
    historyIndex = undefined;
  };
  const remove = (from: number, to: number) => {
    killed = text.slice(from, to);
    text = text.slice(0, from) + text.slice(to);
    cursor = from;
    prune();
    historyIndex = undefined;
  };

  function column(at: number): number {
    return displayWidth(text.slice(lineStart(at), at));
  }
  function indexAtColumn(start: number, end: number, wanted: number): number {
    let position = start;
    let used = 0;
    for (const part of graphemes(text.slice(start, end))) {
      const width = displayWidth(part);
      if (used + width > wanted) break;
      used += width;
      position += part.length;
    }
    return position;
  }

  function moveUp(): boolean {
    const start = lineStart(cursor);
    if (start === 0) return false;
    const previousStart = lineStart(start - 1);
    cursor = snapToStart(indexAtColumn(previousStart, start - 1, column(cursor)));
    return true;
  }
  function moveDown(): boolean {
    const end = lineEnd(cursor);
    if (end >= text.length) return false;
    const nextStart = end + 1;
    cursor = snapToStart(indexAtColumn(nextStart, lineEnd(nextStart), column(cursor)));
    return true;
  }

  function showHistory(index: number | undefined) {
    historyIndex = index;
    const entry = index === undefined ? { text: draft, pastes: draftPastes } : history[index]!;
    text = entry.text;
    pastes = new Map(entry.pastes);
    cursor = text.length;
  }

  return {
    value: () => text,
    expanded() {
      let result = text;
      for (const [label, full] of pastes) result = result.split(label).join(full);
      return result;
    },
    cursor: () => cursor,
    set(value) {
      pastes = new Map();
      text = fold(value);
      cursor = text.length;
      historyIndex = undefined;
    },
    clear() {
      text = "";
      cursor = 0;
      pastes = new Map();
      historyIndex = undefined;
    },
    remember(value) {
      if (value.trim() !== "" && history[history.length - 1]?.text !== value) history.push({ text: value, pastes: new Map([...pastes].filter(([label]) => value.includes(label))) });
      historyIndex = undefined;
    },
    handle(key) {
      const withoutCtrl = !key.ctrl && !key.alt;
      switch (key.name) {
        case "char":
          insert(key.text!.replace(/\r\n?/g, "\n"));
          return "none";
        case "paste":
          insert(fold((key.text ?? "").replace(/\r\n?/g, "\n")));
          return "none";
        case "enter":
          if (key.shift || key.alt || key.ctrl) {
            insert("\n");
            return "none";
          }
          if (text[cursor - 1] === "\\") {
            // a backslash before Enter means "new line" in terminals that cannot tell Shift-Enter apart
            text = text.slice(0, cursor - 1) + "\n" + text.slice(cursor);
            return "none";
          }
          return "submit";
        case "tab":
          return key.shift ? "shift-tab" : "tab";
        case "escape":
          return "escape";
        case "backspace":
          if (key.alt) remove(wordLeft(cursor), cursor);
          else if (cursor > 0) remove(previousBoundary(cursor), cursor);
          return "none";
        case "delete":
          if (cursor < text.length) remove(cursor, nextBoundary(cursor));
          return "none";
        case "left":
          cursor = key.ctrl || key.alt ? wordLeft(cursor) : previousBoundary(cursor);
          return "none";
        case "right":
          cursor = key.ctrl || key.alt ? wordRight(cursor) : nextBoundary(cursor);
          return "none";
        case "home":
          cursor = lineStart(cursor);
          return "none";
        case "end":
          cursor = lineEnd(cursor);
          return "none";
        case "up":
          if (moveUp()) return "none";
          if (history.length > 0 && withoutCtrl) {
            if (historyIndex === undefined) {
              draft = text;
              draftPastes = pastes;
              showHistory(history.length - 1);
            } else if (historyIndex > 0) showHistory(historyIndex - 1);
            cursor = 0;
          }
          return "none";
        case "down":
          if (moveDown()) return "none";
          if (historyIndex !== undefined && withoutCtrl) showHistory(historyIndex + 1 < history.length ? historyIndex + 1 : undefined);
          return "none";
        case "pageup":
          return "page-up";
        case "pagedown":
          return "page-down";
        case "a":
          if (key.ctrl) cursor = lineStart(cursor);
          else if (key.alt) insert("a");
          return "none";
        case "e":
          if (key.ctrl) cursor = lineEnd(cursor);
          return "none";
        case "b":
          if (key.ctrl) cursor = previousBoundary(cursor);
          return "none";
        case "f":
          if (key.ctrl) cursor = nextBoundary(cursor);
          return "none";
        case "k":
          if (key.ctrl) remove(cursor, cursor === lineEnd(cursor) ? Math.min(text.length, cursor + 1) : lineEnd(cursor));
          return "none";
        case "u":
          if (key.ctrl) remove(lineStart(cursor), cursor);
          return "none";
        case "w":
          if (key.ctrl) remove(wordLeft(cursor), cursor);
          return "none";
        case "y":
          if (key.ctrl && killed) insert(killed);
          return "none";
        case "d":
          if (key.ctrl) {
            if (text === "") return "eof";
            if (cursor < text.length) remove(cursor, nextBoundary(cursor));
          }
          return "none";
        case "c":
          return key.ctrl ? "interrupt" : "none";
        case "j":
          if (key.ctrl) insert("\n");
          return "none";
        case "l":
          return "none";
        default:
          return "none";
      }
    },
    layout(width) {
      return layoutText(text, cursor, width);
    },
  };
}

/** Cuts text into display rows (hard wrap by columns) and locates the cursor. */
export function layoutText(text: string, cursor: number, width: number): Layout {
  const limit = Math.max(2, width);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    let row = "";
    let used = 0;
    let rowStartOffset = offset;
    const place = (at: number) => {
      if (cursor === at) {
        cursorRow = rows.length;
        cursorCol = used;
      }
    };
    for (const part of graphemes(line)) {
      const partWidth = displayWidth(part);
      if (used + partWidth > limit) {
        rows.push(row);
        row = "";
        used = 0;
        rowStartOffset = offset;
      }
      place(offset);
      row += part;
      used += partWidth;
      offset += part.length;
    }
    place(offset); // the position after the last character of this line
    void rowStartOffset;
    rows.push(row);
    offset += 1; // the newline
  }
  return { rows, cursorRow, cursorCol };
}
