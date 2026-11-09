// A parser for the TOML subset the config file uses: comments, [tables] and [dotted.tables], key = value with dotted keys,
// basic and literal strings, integers, floats, booleans, arrays (also over several lines) and inline tables.
// Not supported (reported as errors): dates, multi-line strings, arrays of tables.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`config line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

class Cursor {
  position = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  peek(): string | undefined {
    return this.text[this.position];
  }
  rest(): string {
    return this.text.slice(this.position);
  }
}

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const number = lineIndex + 1;
    let line = stripComment(lines[lineIndex]!).trim();
    if (line === "") continue;
    if (line.startsWith("[[")) throw new TomlError("arrays of tables are not supported", number);
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) throw new TomlError("a table header must end with ]", number);
      current = descend(root, parseKeyPath(line.slice(1, -1), number), number);
      continue;
    }
    // a value that opens a bracket may continue on the next lines
    while (needsMore(line) && lineIndex + 1 < lines.length) {
      lineIndex += 1;
      line += ` ${stripComment(lines[lineIndex]!).trim()}`;
    }
    const equals = findEquals(line);
    if (equals === -1) throw new TomlError("expected key = value", number);
    const path = parseKeyPath(line.slice(0, equals), number);
    const cursor = new Cursor(line.slice(equals + 1).trim());
    const value = parseValue(cursor, number);
    if (cursor.rest().trim() !== "") throw new TomlError(`unexpected text after value: ${cursor.rest().trim()}`, number);
    const holder = descend(current, path.slice(0, -1), number);
    const key = path[path.length - 1]!;
    if (key in holder) throw new TomlError(`duplicate key ${key}`, number);
    holder[key] = value;
  }
  return root;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function needsMore(line: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return depth > 0;
}

function findEquals(line: string): number {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "=") return index;
  }
  return -1;
}

function parseKeyPath(text: string, line: number): string[] {
  const keys: string[] = [];
  let index = 0;
  const source = text.trim();
  while (index < source.length) {
    while (source[index] === " ") index += 1;
    const char = source[index];
    if (char === '"' || char === "'") {
      const cursor = new Cursor(source.slice(index));
      keys.push(parseString(cursor, line));
      index += cursor.position;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) throw new TomlError(`invalid key near ${source.slice(index)}`, line);
      keys.push(match[0]);
      index += match[0].length;
    }
    while (source[index] === " ") index += 1;
    if (index < source.length) {
      if (source[index] !== ".") throw new TomlError(`invalid key near ${source.slice(index)}`, line);
      index += 1;
    }
  }
  if (keys.length === 0) throw new TomlError("empty key", line);
  return keys;
}

function descend(root: TomlTable, path: string[], line: number): TomlTable {
  let table = root;
  for (const key of path) {
    const existing = table[key];
    if (existing === undefined) {
      const created: TomlTable = {};
      table[key] = created;
      table = created;
    } else if (typeof existing === "object" && !Array.isArray(existing)) table = existing;
    else throw new TomlError(`${key} is not a table`, line);
  }
  return table;
}

function parseValue(cursor: Cursor, line: number): TomlValue {
  skipSpace(cursor);
  const char = cursor.peek();
  if (char === '"' || char === "'") return parseString(cursor, line);
  if (char === "[") return parseArray(cursor, line);
  if (char === "{") return parseInlineTable(cursor, line);
  const match = /^[^\s,\]}]+/.exec(cursor.rest());
  if (!match) throw new TomlError("missing value", line);
  cursor.position += match[0].length;
  const word = match[0];
  if (word === "true") return true;
  if (word === "false") return false;
  if (/^[+-]?\d[\d_]*$/.test(word)) return Number.parseInt(word.replace(/_/g, ""), 10);
  if (/^[+-]?\d[\d_]*\.\d[\d_]*([eE][+-]?\d+)?$/.test(word)) return Number.parseFloat(word.replace(/_/g, ""));
  throw new TomlError(`cannot read value ${word}`, line);
}

function skipSpace(cursor: Cursor): void {
  while (cursor.peek() === " " || cursor.peek() === "\t") cursor.position += 1;
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };

function parseString(cursor: Cursor, line: number): string {
  const quote = cursor.peek()!;
  cursor.position += 1;
  let out = "";
  while (cursor.position < cursor.text.length) {
    const char = cursor.text[cursor.position]!;
    cursor.position += 1;
    if (char === quote) return out;
    if (char === "\\" && quote === '"') {
      const next = cursor.text[cursor.position];
      cursor.position += 1;
      if (next === "u") {
        const hex = cursor.text.slice(cursor.position, cursor.position + 4);
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor.position += 4;
      } else if (next !== undefined && ESCAPES[next] !== undefined) out += ESCAPES[next];
      else throw new TomlError(`unknown escape \\${next ?? ""}`, line);
    } else out += char;
  }
  throw new TomlError("unterminated string", line);
}

function parseArray(cursor: Cursor, line: number): TomlValue[] {
  cursor.position += 1;
  const items: TomlValue[] = [];
  for (;;) {
    skipSpace(cursor);
    if (cursor.peek() === "]") {
      cursor.position += 1;
      return items;
    }
    items.push(parseValue(cursor, line));
    skipSpace(cursor);
    if (cursor.peek() === ",") cursor.position += 1;
    else if (cursor.peek() !== "]") throw new TomlError("expected , or ] in array", line);
  }
}

function parseInlineTable(cursor: Cursor, line: number): TomlTable {
  cursor.position += 1;
  const table: TomlTable = {};
  for (;;) {
    skipSpace(cursor);
    if (cursor.peek() === "}") {
      cursor.position += 1;
      return table;
    }
    const equals = cursor.text.indexOf("=", cursor.position);
    if (equals === -1) throw new TomlError("expected key = value in inline table", line);
    const path = parseKeyPath(cursor.text.slice(cursor.position, equals), line);
    cursor.position = equals + 1;
    const holder = descend(table, path.slice(0, -1), line);
    holder[path[path.length - 1]!] = parseValue(cursor, line);
    skipSpace(cursor);
    if (cursor.peek() === ",") cursor.position += 1;
    else if (cursor.peek() !== "}") throw new TomlError("expected , or } in inline table", line);
  }
}
