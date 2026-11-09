// Decoding raw terminal input into key events. Understands arrows, Home/End/Delete, Ctrl and Alt combinations,
// Shift-Enter in the common encodings, and bracketed paste (which may arrive in several chunks).

export interface KeyEvent {
  /** "char" carries `text`; "paste" carries the pasted text; the rest are named keys. */
  name: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface KeyDecoder {
  push(chunk: string): KeyEvent[];
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

const CSI_FINAL: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab" };
const CSI_TILDE: Record<string, string> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };

export function createKeyDecoder(): KeyDecoder {
  let pasteBuffer: string | undefined;
  let carry = "";

  function decode(input: string): KeyEvent[] {
    const events: KeyEvent[] = [];
    let text = "";
    const flushText = () => {
      if (text) events.push({ name: "char", text });
      text = "";
    };
    let index = 0;
    while (index < input.length) {
      const char = input[index]!;
      if (char === "\u001b") {
        flushText();
        const parsed = parseEscape(input, index);
        if (parsed.incomplete) {
          carry = input.slice(index);
          return events;
        }
        events.push(...parsed.events);
        index += parsed.length;
        continue;
      }
      const code = char.charCodeAt(0);
      if (char === "\r") {
        flushText();
        events.push({ name: "enter" });
      } else if (char === "\n") {
        flushText();
        events.push({ name: "enter", ctrl: true });
      } else if (char === "\t") {
        flushText();
        events.push({ name: "tab" });
      } else if (code === 0x7f || code === 0x08) {
        flushText();
        events.push({ name: "backspace" });
      } else if (code >= 1 && code <= 26) {
        flushText();
        events.push({ name: String.fromCharCode(code + 96), ctrl: true });
      } else if (code < 32) {
        flushText();
      } else text += char;
      index += 1;
    }
    flushText();
    return events;
  }

  return {
    push(chunk) {
      let input = carry + chunk;
      carry = "";
      const events: KeyEvent[] = [];
      for (;;) {
        if (pasteBuffer !== undefined) {
          const end = input.indexOf(PASTE_END);
          if (end === -1) {
            pasteBuffer += input;
            return events;
          }
          events.push({ name: "paste", text: (pasteBuffer + input.slice(0, end)).replace(/\r\n?/g, "\n") });
          pasteBuffer = undefined;
          input = input.slice(end + PASTE_END.length);
          continue;
        }
        const start = input.indexOf(PASTE_START);
        if (start === -1) {
          events.push(...decode(input));
          return events;
        }
        events.push(...decode(input.slice(0, start)));
        pasteBuffer = "";
        input = input.slice(start + PASTE_START.length);
      }
    },
  };
}

interface Parsed {
  events: KeyEvent[];
  length: number;
  incomplete?: boolean;
}

function modifiers(code: number): Pick<KeyEvent, "ctrl" | "alt" | "shift"> {
  const bits = code - 1;
  return { ...(bits & 1 ? { shift: true } : {}), ...(bits & 2 ? { alt: true } : {}), ...(bits & 4 ? { ctrl: true } : {}) };
}

function parseEscape(input: string, index: number): Parsed {
  const next = input[index + 1];
  if (next === undefined) return { events: [{ name: "escape" }], length: 1 };
  if (next === "[") {
    const match = /^\u001b\[([0-9;:?]*)([@-~])/.exec(input.slice(index));
    if (!match) return { events: [], length: 0, incomplete: true };
    const [whole, params = "", final = ""] = match;
    const numbers = params.split(";").map((part) => Number.parseInt(part, 10));
    const mod = numbers[1] ? modifiers(numbers[1]) : {};
    if (final === "~") {
      if (numbers[0] === 27 && numbers[2] === 13) return { events: [{ name: "enter", ...modifiers(numbers[1] ?? 1) }], length: whole.length };
      const name = CSI_TILDE[String(numbers[0])];
      return { events: name ? [{ name, ...mod }] : [], length: whole.length };
    }
    if (final === "u") {
      const code = numbers[0] ?? 0;
      const m = modifiers(numbers[1] ?? 1);
      if (code === 13) return { events: [{ name: "enter", ...m }], length: whole.length };
      if (code === 27) return { events: [{ name: "escape" }], length: whole.length };
      if (code === 9) return { events: [{ name: "tab", ...m }], length: whole.length };
      if (code === 127) return { events: [{ name: "backspace", ...m }], length: whole.length };
      if (code >= 32 && !m.ctrl && !m.alt) return { events: [{ name: "char", text: String.fromCodePoint(code) }], length: whole.length };
      if (code >= 97 && code <= 122) return { events: [{ name: String.fromCharCode(code), ...m }], length: whole.length };
      return { events: [], length: whole.length };
    }
    const name = CSI_FINAL[final];
    if (name === "tab") return { events: [{ name: "tab", shift: true }], length: whole.length };
    return { events: name ? [{ name, ...mod }] : [], length: whole.length };
  }
  if (next === "O") {
    const final = input[index + 2];
    if (final === undefined) return { events: [], length: 0, incomplete: true };
    const name = CSI_FINAL[final];
    return { events: name ? [{ name }] : [], length: 3 };
  }
  if (next === "\r") return { events: [{ name: "enter", alt: true }], length: 2 };
  if (next === "\u007f") return { events: [{ name: "backspace", alt: true }], length: 2 };
  const code = next.codePointAt(0)!;
  const length = 1 + String.fromCodePoint(code).length;
  if (code >= 1 && code <= 26) return { events: [{ name: String.fromCharCode(code + 96), ctrl: true, alt: true }], length };
  return { events: [{ name: "char", text: String.fromCodePoint(code), alt: true }], length };
}
