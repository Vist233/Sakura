import type { Tool } from "@sakura/kernel";

/*
 * Rule texts adapted from the ideas in Pi's system prompt (MIT, Copyright (c) 2025 Mario Zechner) and the
 * task-execution principles of OpenAI Codex's base instructions (Apache-2.0); reworded and shortened.
 * See THIRD_PARTY_NOTICES.md.
 */

const PREAMBLE = "You are a coding agent. You help the user by reading files, running commands, editing code and writing new files. Be precise, safe and helpful.";

const RULES = [
  "Keep going until the user's request is completely resolved before you end your turn. Do not stop at a plan or a partial result.",
  "Fix problems at the root cause rather than patching symptoms, and avoid unneeded complexity.",
  "Keep changes minimal and consistent with the style of the existing code. Do not fix unrelated bugs; you may mention them in your final message.",
  "In an existing codebase, do exactly what was asked with precision. In a brand-new project you may be more ambitious.",
  "If the project has tests or a way to build or run, use them to check your work. Start with the most specific check for what you changed, then widen.",
  "Do not re-read a file only to confirm an edit succeeded; a failed edit returns an error.",
  "Do not commit changes or create branches unless the user asks.",
  "Do not add comments or copyright headers to code unless the user asks.",
  "Before a long or risky step, say in one short sentence what you are about to do. Do not narrate trivial reads.",
  "Be concise. Show file paths clearly so the user can open them. Do not paste the full contents of files you have already written.",
  "Instruction files from the project (AGENTS.md) and direct user messages take precedence over these rules.",
];

/** Rules that belong to one tool; they appear only when that tool is available. */
const TOOL_RULES: Record<string, string[]> = {
  read: ["Use read to examine files instead of cat or sed."],
  write: ["Use write only for new files or complete rewrites. Keep each file under about 2000 lines; split larger work across several files, because a very long tool call can be cut off."],
  edit: [
    "Use edit for precise changes (edits[].oldText must match exactly).",
    "When changing multiple separate locations in one file, use one edit call with several entries in edits[].",
    "Each edits[].oldText is matched against the original file, not after earlier edits. Do not emit overlapping or nested edits; merge nearby changes.",
    "Keep edits[].oldText as small as possible while still unique in the file.",
  ],
  bash: [
    "When searching for text or files, prefer rg (rg --files for file names); fall back to grep or find if rg is missing.",
    "Do not use scripts to print large chunks of a file; use read with offset and limit.",
    "Commands run without a terminal and cannot read input. Always pass non-interactive flags (for example --yes, -y, --no-input, CI=1); a command that waits for input will hang.",
  ],
};

const firstSentence = (description: string): string => (description.split(/(?<=\.)\s/)[0] ?? description).trim();

export interface SystemPromptOptions {
  tools: readonly Tool[];
  cwd: string;
  platform: string;
  /** Extra rules from plugins. */
  rules?: string[];
}

/** Builds the system prompt: preamble, tools, rules, environment. Callers can replace the whole thing. */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const toolLines = options.tools.map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`);
  const rules = [...new Set([...options.tools.flatMap((tool) => TOOL_RULES[tool.name] ?? []), ...RULES, ...(options.rules ?? [])])];
  return [
    PREAMBLE,
    options.tools.length > 0 ? `<tools>\n${toolLines.join("\n")}\n</tools>` : "",
    `<rules>\n${rules.map((rule) => `- ${rule}`).join("\n")}\n</rules>`,
    `<environment>\nWorking directory: ${options.cwd}\nPlatform: ${options.platform}\n</environment>`,
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}
