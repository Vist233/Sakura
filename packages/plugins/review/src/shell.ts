/** A small, conservative reader for shell command lines. Anything it cannot read with certainty is marked complex. */
export interface ParsedShell {
  /** Words of each simple command, in order; leading VAR=value assignments removed. */
  commands: string[][];
  /** The line uses substitution, heredocs, subshells or other things this reader does not follow. */
  complex: boolean;
  /** Some command writes through a redirection to something other than /dev/null or a duplicated descriptor. */
  writesFile: boolean;
}

const OPERATORS = ["&&", "||", ";", "|", "&", "\n"];

export function parseShell(command: string): ParsedShell {
  const commands: string[][] = [];
  let current: string[] = [];
  let word = "";
  let inWord = false;
  let complex = false;
  let writesFile = false;
  let expectRedirectTarget = false;

  const endWord = () => {
    if (!inWord) return;
    if (expectRedirectTarget) {
      if (word !== "/dev/null" && !word.startsWith("&")) writesFile = true;
      expectRedirectTarget = false;
    } else {
      current.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.length > 0) {
      while (current.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] as string)) current.shift();
      if (current.length > 0) commands.push(current);
    }
    current = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string;
    if (char === "\\") {
      word += command[index + 1] ?? "";
      inWord = true;
      index++;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return { commands, complex: true, writesFile };
      word += command.slice(index + 1, end);
      inWord = true;
      index = end;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let text = "";
      while (end < command.length && command[end] !== '"') {
        if (command[end] === "\\" && end + 1 < command.length) {
          text += command[end + 1];
          end += 2;
          continue;
        }
        if (command[end] === "$" && (command[end + 1] === "(" || command[end + 1] === "{")) complex = true;
        if (command[end] === "`") complex = true;
        text += command[end];
        end++;
      }
      if (end >= command.length) return { commands, complex: true, writesFile };
      word += text;
      inWord = true;
      index = end;
      continue;
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(") || (char === "<" && command[index + 1] === "(") || (char === ">" && command[index + 1] === "(")) {
      complex = true;
    }
    if (char === "(" || char === ")" || char === "{" || char === "}") {
      if (!inWord) complex = true;
    }
    const operator = OPERATORS.find((candidate) => command.startsWith(candidate, index));
    if (operator && !(operator === "&" && (command[index - 1] === ">" || command[index + 1] === ">"))) {
      endCommand();
      index += operator.length - 1;
      continue;
    }
    if (char === "<" && command[index + 1] === "<") {
      complex = true;
      index++;
      continue;
    }
    if (char === ">" || char === "<") {
      const digits = /^[0-9]+$/.test(word) && inWord ? word : "";
      if (digits) {
        word = "";
        inWord = false;
      } else endWord();
      let end = index;
      if (command[end + 1] === ">") end++;
      if (char === ">" || (char === "<" && false)) {
        if (command[end + 1] === "&") {
          end++; // 2>&1 style duplication: no file is written
          while (command[end + 1] && /[0-9-]/.test(command[end + 1] as string)) end++;
        } else expectRedirectTarget = true;
      }
      index = end;
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    inWord = true;
  }
  endCommand();
  return { commands, complex, writesFile };
}
