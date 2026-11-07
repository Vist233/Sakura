/** Limits on how much of a tool's output the model gets to see. Defaults follow Pi: 2000 lines or 50KB. */
export interface FoldLimits {
  maxLines: number;
  maxBytes: number;
}

export const DEFAULT_FOLD: FoldLimits = { maxLines: 2000, maxBytes: 50 * 1024 };

export interface Folded {
  text: string;
  truncated: boolean;
  totalLines: number;
  shownLines: number;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** The first `maxBytes` bytes of a string without cutting a character in half. */
function headBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] ?? 0) >> 6 === 0b10) end--; // never start inside a multi-byte character
  return buffer.subarray(0, end).toString("utf8");
}

function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] ?? 0) >> 6 === 0b10) start++;
  return buffer.subarray(start).toString("utf8");
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Keep the start of the text (for files). */
export function foldHead(text: string, limits: FoldLimits = DEFAULT_FOLD): Folded {
  const lines = splitLines(text);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const cost = byteLength(line) + (kept.length > 0 ? 1 : 0); // the newline between this line and the one next to it
    if (kept.length >= limits.maxLines || bytes + cost > limits.maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  if (kept.length === 0 && lines.length > 0) {
    // one line alone is over the byte limit: show the start of it
    return { text: headBytes(lines[0] ?? "", limits.maxBytes), truncated: true, totalLines: lines.length, shownLines: 1 };
  }
  return { text: kept.join("\n"), truncated: kept.length < lines.length, totalLines: lines.length, shownLines: kept.length };
}

/** Keep the end of the text (for command output, where the end matters most). */
export function foldTail(text: string, limits: FoldLimits = DEFAULT_FOLD): Folded {
  const lines = splitLines(text);
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    const cost = byteLength(line) + (kept.length > 0 ? 1 : 0); // the newline between this line and the one next to it
    if (kept.length >= limits.maxLines || bytes + cost > limits.maxBytes) break;
    kept.unshift(line);
    bytes += cost;
  }
  if (kept.length === 0 && lines.length > 0) {
    return { text: tailBytes(lines.at(-1) ?? "", limits.maxBytes), truncated: true, totalLines: lines.length, shownLines: 1 };
  }
  return { text: kept.join("\n"), truncated: kept.length < lines.length, totalLines: lines.length, shownLines: kept.length };
}
