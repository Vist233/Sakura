// Markdown to terminal lines. Handles the parts model replies use: headings, paragraphs, lists (nested, ordered, task),
// quotes, fenced code, inline code, bold/italic/strike, links, tables and rules.
import { createPalette, displayWidth, hyperlink, padEnd, wrapAnsi } from "./ansi.ts";
import type { Palette } from "./ansi.ts";

export interface MarkdownOptions {
  /** Terminal columns available. */
  width: number;
  /** Write ANSI styles. Off for logs and pipes. */
  color: boolean;
  /** Write OSC 8 hyperlinks (terminals that support them make link text clickable). Default off. */
  hyperlinks?: boolean;
}

interface Context {
  pal: Palette;
  color: boolean;
  links: boolean;
}

export function renderMarkdown(text: string, options: MarkdownOptions): string[] {
  const context: Context = { pal: createPalette(options.color), color: options.color, links: options.hyperlinks ?? false };
  const lines = renderBlocks(text.replace(/\r\n?/g, "\n").split("\n"), Math.max(10, options.width), context);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------- blocks ----------

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function renderBlocks(lines: string[], width: number, context: Context, tight = false): string[] {
  const out: string[] = [];
  const addBlock = (block: string[]) => {
    if (block.length === 0) return;
    if (!tight && out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(...block);
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index]!)) {
        body.push(lines[index]!.replace(new RegExp(`^ {0,${fence[1]!.length}}`), ""));
        index += 1;
      }
      index += 1; // the closing fence (a missing one ends at the end of the text)
      addBlock(renderCode(body, fence[3] ?? "", width, context));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      addBlock(renderHeading(heading[1]!.length, heading[2]!, width, context));
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      addBlock([context.pal.dim("─".repeat(Math.min(width, 60)))]);
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      addBlock(renderBlocks(quoted, width - 2, context).map((inner) => `${context.pal.dim("│")} ${inner}`.trimEnd()));
      continue;
    }
    if (isTableStart(lines, index)) {
      const rows: string[] = [];
      while (index < lines.length && lines[index]!.trim() !== "" && lines[index]!.includes("|")) {
        rows.push(lines[index]!);
        index += 1;
      }
      addBlock(renderTable(rows, width, context));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const taken = takeList(lines, index);
      index = taken.next;
      addBlock(renderList(taken.items, width, context));
      continue;
    }
    // paragraph: runs until a blank line or the start of another block
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    addBlock(wrapAnsi(renderInline(paragraph.join("\n").replace(/\n/g, " "), context), width));
  }
  return out;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(lines, index);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]!;
  const separator = lines[index + 1];
  return header.includes("|") && separator !== undefined && separator.includes("-") && TABLE_SEPARATOR.test(separator) && splitRow(header).length === splitRow(separator).length;
}

function renderHeading(level: number, text: string, width: number, context: Context): string[] {
  const { pal } = context;
  const inline = renderInline(text, context);
  const styled = level === 1 ? pal.bold(pal.underline(inline)) : level === 2 ? pal.bold(inline) : level === 3 ? pal.bold(pal.italic(inline)) : pal.italic(inline);
  return wrapAnsi(styled, width);
}

// ---------- code ----------

function renderCode(body: string[], language: string, width: number, context: Context): string[] {
  const { pal } = context;
  const label = language ? pal.dim(`  ${language}`) : "";
  const rendered = body.flatMap((codeLine) => {
    const wrapped = wrapAnsi(codeLine === "" ? "" : codeLine.replace(/\t/g, "  "), Math.max(10, width - 2));
    return wrapped.map((part) => `  ${pal.cyan(part)}`);
  });
  const rule = pal.dim("  " + "┄".repeat(Math.min(width - 2, 40)));
  return [...(label ? [label] : [rule]), ...rendered, rule];
}

// ---------- lists ----------

interface ListItem {
  ordered: boolean;
  number: number;
  lines: string[];
}

function takeList(lines: string[], start: number): { items: ListItem[]; next: number } {
  const items: ListItem[] = [];
  const first = LIST_ITEM.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]!);
    if (!match || match[1]!.length !== baseIndent || /\d/.test(match[2]!) !== /\d/.test(first[2]!)) break;
    const marker = match[2]!;
    const contentIndent = baseIndent + marker.length + 1;
    const itemLines = [match[3]!];
    index += 1;
    while (index < lines.length) {
      const current = lines[index]!;
      if (current.trim() === "") {
        // a blank line stays in the item only when the next non-blank line is indented under it
        let lookahead = index + 1;
        while (lookahead < lines.length && lines[lookahead]!.trim() === "") lookahead += 1;
        const following = lines[lookahead];
        if (following !== undefined && leadingSpaces(following) >= contentIndent) {
          itemLines.push("");
          index += 1;
          continue;
        }
        break;
      }
      if (leadingSpaces(current) >= contentIndent) {
        itemLines.push(current.slice(contentIndent));
        index += 1;
        continue;
      }
      const next = LIST_ITEM.exec(current);
      if (next && next[1]!.length <= baseIndent) break;
      if (startsBlock(lines, index)) break;
      itemLines.push(current.trim()); // lazy continuation of the paragraph
      index += 1;
    }
    items.push({ ordered: /\d/.test(marker), number: Number.parseInt(marker, 10), lines: itemLines });
    // blank lines between items of one list
    let lookahead = index;
    while (lookahead < lines.length && lines[lookahead]!.trim() === "") lookahead += 1;
    const following = lines[lookahead];
    const nextItem = following === undefined ? null : LIST_ITEM.exec(following);
    if (nextItem && nextItem[1]!.length === baseIndent) index = lookahead;
    else break;
  }
  return { items, next: index };
}

const leadingSpaces = (line: string) => line.length - line.trimStart().length;

function renderList(items: ListItem[], width: number, context: Context): string[] {
  const { pal } = context;
  const out: string[] = [];
  const markerWidth = Math.max(...items.map((item, position) => (item.ordered ? `${item.number + 0 * position}.`.length : 1))) + 1;
  for (const item of items) {
    const task = /^\[([ xX])\]\s+/.exec(item.lines[0]!);
    const body = task ? [item.lines[0]!.slice(task[0].length), ...item.lines.slice(1)] : item.lines;
    const marker = task ? (task[1] === " " ? "☐" : "☑") : item.ordered ? `${item.number}.` : "•";
    const inner = renderBlocks(body, width - markerWidth, context, !body.includes(""));
    const styledMarker = task ? (task[1] === " " ? pal.dim(marker) : pal.green(marker)) : pal.dim(marker);
    const gutter = markerWidth - displayWidth(marker);
    inner.forEach((line, position) => {
      out.push(position === 0 ? `${styledMarker}${" ".repeat(gutter)}${line}` : line === "" ? "" : `${" ".repeat(markerWidth)}${line}`);
    });
    if (inner.length === 0) out.push(styledMarker);
  }
  return out;
}

// ---------- tables ----------

function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

type Align = "left" | "center" | "right";

function alignment(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : "left";
}

function fitColumns(natural: number[], available: number): number[] {
  const widths = [...natural];
  const minimum = 4;
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    const largest = widths.indexOf(Math.max(...widths));
    if (widths[largest]! <= minimum) break;
    widths[largest] = widths[largest]! - 1;
  }
  return widths;
}

function renderTable(rows: string[], width: number, context: Context): string[] {
  const { pal } = context;
  const header = splitRow(rows[0]!);
  const aligns = splitRow(rows[1]!).map(alignment);
  const body = rows.slice(2).map((row) => {
    const cells = splitRow(row);
    while (cells.length < header.length) cells.push("");
    return cells.slice(0, header.length);
  });
  const all = [header, ...body].map((row) => row.map((cell) => renderInline(cell, context)));
  const natural = header.map((_, column) => Math.max(1, ...all.map((row) => Math.max(...row[column]!.split("\n").map(displayWidth), 0))));
  const chrome = header.length * 3 + 1;
  const widths = fitColumns(natural, Math.max(header.length * 4, width - chrome));

  const border = (left: string, middle: string, right: string) => pal.dim(left + widths.map((cell) => "─".repeat(cell + 2)).join(middle) + right);
  const renderRow = (cells: string[], bold: boolean): string[] => {
    const wrapped = cells.map((cell, column) => wrapAnsi(cell, widths[column]!));
    const height = Math.max(...wrapped.map((cell) => cell.length));
    return Array.from({ length: height }, (_, lineIndex) => {
      const parts = wrapped.map((cell, column) => {
        const text = cell[lineIndex] ?? "";
        const styled = bold ? pal.bold(text) : text;
        const gap = widths[column]! - displayWidth(text);
        const align = aligns[column] ?? "left";
        if (align === "right") return " ".repeat(gap) + styled;
        if (align === "center") return " ".repeat(Math.floor(gap / 2)) + styled + " ".repeat(gap - Math.floor(gap / 2));
        return padEnd(styled, widths[column]!);
      });
      return `${pal.dim("│")} ${parts.join(` ${pal.dim("│")} `)} ${pal.dim("│")}`;
    });
  };
  const out = [border("┌", "┬", "┐"), ...renderRow(all[0]!, true), border("├", "┼", "┤")];
  all.slice(1).forEach((row) => out.push(...renderRow(row, false)));
  out.push(border("└", "┴", "┘"));
  return out;
}

// ---------- inline ----------

export function renderInline(text: string, context: Context): string {
  const { pal } = context;
  let out = "";
  let index = 0;
  const flushPlain = (value: string) => {
    out += value;
  };
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length && /[\\`*_{}\[\]()#+\-.!|~<>]/.test(text[index + 1]!)) {
      flushPlain(text[index + 1]!);
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      if (close > index + run.length - 1 && close !== -1) {
        const code = text.slice(index + run.length, close).replace(/^ (.*) $/, "$1");
        out += pal.cyan(code);
        index = close + run.length;
        continue;
      }
      flushPlain(run);
      index += run.length;
      continue;
    }
    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      const marker = text.slice(index, index + 2);
      const close = findClosing(text, marker, index + 2);
      if (close !== -1 && text[index + 2] !== " ") {
        out += pal.bold(renderInline(text.slice(index + 2, close), context));
        index = close + 2;
        continue;
      }
    }
    if (text.startsWith("~~", index)) {
      const close = findClosing(text, "~~", index + 2);
      if (close !== -1) {
        out += pal.strike(renderInline(text.slice(index + 2, close), context));
        index = close + 2;
        continue;
      }
    }
    if ((char === "*" || char === "_") && text[index + 1] !== " " && text[index + 1] !== undefined) {
      const previous = text[index - 1];
      const wordBefore = previous !== undefined && /[\p{L}\p{N}]/u.test(previous);
      if (!(char === "_" && wordBefore)) {
        const close = findClosing(text, char, index + 1);
        if (close !== -1 && text[close - 1] !== " " && !(char === "_" && /[\p{L}\p{N}]/u.test(text[close + 1] ?? ""))) {
          out += pal.italic(renderInline(text.slice(index + 1, close), context));
          index = close + 1;
          continue;
        }
      }
    }
    if (char === "[") {
      const link = /^\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
      if (link) {
        const label = renderInline(link[1]!, context);
        const url = link[2]!;
        const shown = pal.underline(pal.blue(label));
        out += context.links ? hyperlink(shown, url, true) : link[1] === url ? shown : `${shown} ${pal.dim(`(${url})`)}`;
        index += link[0].length;
        continue;
      }
    }
    if (char === "<") {
      const auto = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(index));
      if (auto) {
        out += pal.underline(pal.blue(auto[1]!));
        index += auto[0].length;
        continue;
      }
    }
    if (char === "h") {
      const bare = /^https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"]/.exec(text.slice(index));
      if (bare && (index === 0 || /[\s(]/.test(text[index - 1]!))) {
        out += pal.underline(pal.blue(bare[0]));
        index += bare[0].length;
        continue;
      }
    }
    flushPlain(char);
    index += 1;
  }
  return out;
}

function findClosing(text: string, marker: string, from: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "`") {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      index = close === -1 ? index + run.length : close + run.length;
      continue;
    }
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text.startsWith(marker, index) && index > from) {
      if (marker.length === 1 && text[index + 1] === marker) {
        index += 2;
        continue;
      }
      return index;
    }
    index += 1;
  }
  return -1;
}

export function createInlineContext(color: boolean): Context {
  return { pal: createPalette(color), color, links: false };
}
