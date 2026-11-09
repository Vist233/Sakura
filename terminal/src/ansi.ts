// Terminal text helpers: styles, stripping, display width and wrapping that keeps styles.

const ESC = "\u001b";
// SGR sequences (colours, bold) and OSC 8 hyperlinks; the only escapes this application writes inside text.
const ESCAPE_PATTERN = /\u001b\[[0-9;]*m|\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/y;

export interface Styler {
  (text: string): string;
}

function makeStyler(open: string, close: string, enabled: boolean): Styler {
  return enabled ? (text) => `${ESC}[${open}m${text}${ESC}[${close}m` : (text) => text;
}

export interface Palette {
  bold: Styler;
  dim: Styler;
  italic: Styler;
  underline: Styler;
  strike: Styler;
  red: Styler;
  green: Styler;
  yellow: Styler;
  blue: Styler;
  magenta: Styler;
  cyan: Styler;
  gray: Styler;
  inverse: Styler;
}

export function createPalette(enabled: boolean): Palette {
  return {
    bold: makeStyler("1", "22", enabled),
    dim: makeStyler("2", "22", enabled),
    italic: makeStyler("3", "23", enabled),
    underline: makeStyler("4", "24", enabled),
    strike: makeStyler("9", "29", enabled),
    red: makeStyler("31", "39", enabled),
    green: makeStyler("32", "39", enabled),
    yellow: makeStyler("33", "39", enabled),
    blue: makeStyler("34", "39", enabled),
    magenta: makeStyler("35", "39", enabled),
    cyan: makeStyler("36", "39", enabled),
    gray: makeStyler("90", "39", enabled),
    inverse: makeStyler("7", "27", enabled),
  };
}

/** A hyperlink; terminals that do not know OSC 8 show the text only. */
export function hyperlink(text: string, url: string, enabled: boolean): string {
  return enabled ? `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\` : text;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function graphemeWidth(grapheme: string): number {
  const code = grapheme.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (code === 0x200b || code === 0xfe0f) return 0;
  if (WIDE_RANGES.some(([low, high]) => code >= low && code <= high)) return 2;
  if (grapheme.includes("️") && code > 0x2000) return 2;
  return 1;
}

/** How many terminal columns a text takes (escapes count zero, CJK and emoji count two). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(stripAnsi(text))) width += graphemeWidth(segment);
  return width;
}

interface Token {
  kind: "escape" | "text";
  value: string;
  width: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let plain = "";
  const flush = () => {
    if (!plain) return;
    for (const { segment } of segmenter.segment(plain)) tokens.push({ kind: "text", value: segment, width: graphemeWidth(segment) });
    plain = "";
  };
  while (index < text.length) {
    if (text[index] === ESC) {
      ESCAPE_PATTERN.lastIndex = index;
      const match = ESCAPE_PATTERN.exec(text);
      if (match) {
        flush();
        tokens.push({ kind: "escape", value: match[0], width: 0 });
        index += match[0].length;
        continue;
      }
    }
    plain += text[index];
    index += 1;
  }
  flush();
  return tokens;
}

/** Cuts a text to a number of columns, adding "…" when something was cut. Styles are closed at the cut. */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let out = "";
  for (const token of tokenize(text)) {
    if (token.kind === "escape") {
      out += token.value;
      continue;
    }
    if (used + token.width > width - 1) break;
    out += token.value;
    used += token.width;
  }
  return `${out}…${ESC}[0m`;
}

const isSpace = (token: Token) => token.kind === "text" && /^\s$/.test(token.value);

/**
 * Wraps text to a width. Breaks at spaces when it can and inside a word when it must (long words, CJK text).
 * A style that is active at a break is closed at the end of the line and opened again on the next one.
 * Newlines in the input start a new line.
 */
export function wrapAnsi(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const result: string[] = [];
  for (const paragraph of text.split("\n")) result.push(...wrapParagraph(paragraph, limit));
  return result;
}

function wrapParagraph(paragraph: string, width: number): string[] {
  const tokens = tokenize(paragraph);
  const lines: string[] = [];
  let active: string[] = [];
  let line = "";
  let lineWidth = 0;
  let pendingSpace: Token[] = [];
  // escapes seen after a space belong to the next word, so a style never covers the space before it
  let pendingEscapes: Token[] = [];

  const track = (token: Token) => {
    if (token.kind !== "escape" || !token.value.includes("[")) return;
    active = /^\u001b\[0?m$/.test(token.value) ? [] : [...active, token.value];
  };
  const endLine = () => {
    lines.push(active.length > 0 ? `${line}${ESC}[0m` : line);
    line = active.join("");
    lineWidth = 0;
  };

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "escape") {
      if (pendingSpace.length > 0) pendingEscapes.push(token);
      else {
        line += token.value;
        track(token);
      }
      index += 1;
      continue;
    }
    if (isSpace(token)) {
      pendingSpace.push(token);
      index += 1;
      continue;
    }
    // collect a word: consecutive non-space text tokens (escapes inside stay attached)
    const word: Token[] = [];
    let wordWidth = 0;
    while (index < tokens.length && !isSpace(tokens[index]!)) {
      const next = tokens[index]!;
      word.push(next);
      wordWidth += next.width;
      index += 1;
    }
    const spaceWidth = lineWidth === 0 ? 0 : pendingSpace.length;
    if (lineWidth > 0 && lineWidth + spaceWidth + wordWidth > width) endLine();
    else if (lineWidth > 0) {
      line += pendingSpace.map((space) => space.value).join("");
      lineWidth += spaceWidth;
    } else if (lines.length === 0 && pendingSpace.length > 0) {
      // leading indentation of the paragraph is kept
      line += pendingSpace.map((space) => space.value).join("");
      lineWidth += pendingSpace.length;
    }
    pendingSpace = [];
    for (const escape of pendingEscapes) {
      line += escape.value;
      track(escape);
    }
    pendingEscapes = [];
    for (const piece of word) {
      if (piece.kind === "escape") {
        line += piece.value;
        track(piece);
        continue;
      }
      if (lineWidth + piece.width > width && lineWidth > 0) endLine();
      line += piece.value;
      lineWidth += piece.width;
    }
  }
  for (const escape of pendingEscapes) {
    line += escape.value;
    track(escape);
  }
  lines.push(active.length > 0 ? `${line}${ESC}[0m` : line);
  return lines;
}

/** Pads with spaces to a display width (never cuts). */
export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
