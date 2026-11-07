import type { Authorizer, Verdict } from "./chain.ts";
import { parseShell } from "./shell.ts";

const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "which",
  "whoami",
  "date",
  "uname",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "id",
  "hostname",
  "sleep",
  "test",
  "[",
  "cd",
  "jq",
  "nl",
  "tac",
  "rev",
  "column",
  "md5sum",
  "sha256sum",
  "shasum",
  "ps",
  "uptime",
  "find",
]);

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "ls-tree", "cat-file", "grep", "rev-list"]);

const SENSITIVE =
  /(?:^|[\s/"'=])(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.env(?:\.[\w-]+)?|credentials|shadow)(?=$|[\s/"'])|\/etc\/(?:shadow|sudoers)/;

function commandIsReadOnly(words: string[]): boolean {
  const name = (words[0] ?? "").replace(/^.*\//, "");
  const args = words.slice(1);
  if (name === "git") {
    const VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
    let index = 0;
    while (index < args.length && (args[index] as string).startsWith("-")) index += VALUE_FLAGS.has(args[index] as string) ? 2 : 1;
    const sub = args[index];
    return sub !== undefined && READ_ONLY_GIT.has(sub);
  }
  if (!READ_ONLY.has(name)) return false;
  if (name === "find" && args.some((word) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"].includes(word))) return false;
  if (name === "sort" && args.some((word) => word === "-o" || word.startsWith("--output"))) return false;
  if (name === "jq" && args.some((word) => word === "-i" || word.startsWith("--in-place"))) return false;
  return true;
}

/** Where a program name counts as being run: at the start, after ; & | or (, optionally behind sudo and the like, optionally with a path. */
const RUNS = String.raw`(?:^|[;&|(])\s*(?:(?:sudo|nohup|exec|time|command)\s+)*(?:\S*\/)?`;

/** Things no instruction from the user should make us run unseen. */
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/(^|[\s;&|])rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/\*|~\/|\.\.?\/?)(\s|$)/, "deleting the filesystem root, the home directory or a parent directory"],
  [/(^|[\s;&|])rm\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME)\*?(\s|$)/, "deleting the filesystem root or the home directory"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "a fork bomb"],
  [new RegExp(`${RUNS}mkfs(\\.\\w+)?(\\s|$)`), "formatting a filesystem"],
  [/(^|[\s;&|])dd\s[^;|&]*of=\/dev\/(sd|hd|nvme|disk|mmcblk)/, "writing to a disk device"],
  [/>\s*\/dev\/(sd|hd|nvme|disk|mmcblk)/, "writing to a disk device"],
  [/(^|[\s;&|])chmod\s+(-[a-zA-Z]+\s+)*(-R|--recursive)\s+[0-7]{3,4}\s+\/(\s|$)/, "changing permissions of the whole filesystem"],
  [new RegExp(`${RUNS}(shutdown|reboot|halt|poweroff)(\\s|[);&|]|$)`), "shutting the machine down"],
  [/(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|python3?|perl|ruby|node)\b/, "running downloaded code without looking at it"],
];

export function mentionsSensitivePath(text: string): boolean {
  return SENSITIVE.test(text);
}

/**
 * Deterministic rules, no model: read-only calls are allowed, catastrophic ones are refused, everything else
 * is passed on. Reading credentials counts as sensitive and is passed on instead of allowed.
 */
export const hardRules: Authorizer = {
  name: "hard-rules",
  async review(call, { tool }): Promise<Verdict> {
    const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>;

    if (call.name === "bash" || tool(call.name)?.effect === "exec") {
      const command = typeof args.command === "string" ? args.command : "";
      for (const [pattern, what] of CATASTROPHIC) {
        if (pattern.test(command)) return { kind: "deny", reason: `This command looks like ${what}. It is never allowed.` };
      }
      const parsed = parseShell(command);
      if (parsed.complex || parsed.writesFile || parsed.commands.length === 0) return { kind: "pass" };
      if (!parsed.commands.every(commandIsReadOnly)) return { kind: "pass" };
      if (mentionsSensitivePath(command)) return { kind: "pass" };
      return { kind: "allow", reason: "read-only command" };
    }

    if (tool(call.name)?.effect === "read") {
      const path = typeof args.path === "string" ? args.path : "";
      return mentionsSensitivePath(path) ? { kind: "pass" } : { kind: "allow", reason: "read-only tool" };
    }
    return { kind: "pass" };
  },
};
