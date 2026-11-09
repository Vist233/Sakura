// Slash commands: the table, parsing a typed line, and completion. A handler talks to the application only through CommandHost.

export interface CommandHost {
  /** Shows Markdown text in the transcript as information (not as a model reply). */
  print(markdown: string): void;
  /** Shows an error in the transcript. */
  fail(text: string): void;
  help(): string;
  status(): Promise<string>;
  models(): string;
  switchModel(provider: string | undefined, model: string | undefined): Promise<void>;
  permissions(name: string | undefined): Promise<void> | void;
  redaction(value: "on" | "off" | undefined): Promise<void>;
  compact(): Promise<void>;
  newSession(): Promise<void>;
  clearScreen(): Promise<void>;
  /** Without a reference, lets the user pick one. */
  resume(reference: string | undefined): Promise<void>;
  fork(): Promise<void>;
  undo(): Promise<void>;
  rename(title: string): Promise<void>;
  /** Starts a run with a canned prompt. */
  runPrompt(prompt: string): void;
  diff(): Promise<void>;
  goal(argument: string | undefined): Promise<void>;
  mcp(): string;
  exit(): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  /** Can be used while the agent is working. */
  duringRun?: boolean;
  run(args: string, host: CommandHost): Promise<void> | void;
}

const INIT_PROMPT =
  "[/init] Create an AGENTS.md file in the current directory that tells future coding agents how to work in this project: what it is, how to build, test and run it, the code layout, and the conventions you can see in the code. Look at the project first (package manifests, README, source layout, existing tests). Keep it short and factual; do not invent commands you have not seen. If an AGENTS.md already exists, improve it instead of replacing it.";

export interface ReviewTarget {
  base?: string | undefined;
  commit?: string | undefined;
  focus?: string | undefined;
}

/** The prompt for a review: the uncommitted changes (default), the changes against a base branch, or one commit. */
export function reviewPrompt(target: ReviewTarget = {}): string {
  const what = target.base
    ? `the changes of this branch against \`${target.base}\` (use \`git diff ${target.base}...HEAD\` and \`git log ${target.base}..HEAD\`)`
    : target.commit
      ? `the commit ${target.commit} (use \`git show ${target.commit}\`)`
      : "the uncommitted changes: staged, unstaged and untracked files (use `git status`, `git diff` and `git diff --staged`; read untracked files directly; if there are no changes, review the last commit with `git show`)";
  const focus = target.focus ? `\n\nFocus of this review: ${target.focus}` : "";
  return `[/review] Review ${what}. Use your shell tool; read the surrounding code where needed. Report problems in order of severity: bugs, risky behaviour, missing tests, unclear code. For each point give the file and line and a concrete suggestion. Do not change any files.${focus}`;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", aliases: ["?"], usage: "/help", summary: "list the commands", duringRun: true, run: (_args, host) => host.print(host.help()) },
  { name: "status", usage: "/status", summary: "session, model, permissions and token usage", duringRun: true, run: async (_args, host) => host.print(await host.status()) },
  {
    name: "model",
    usage: "/model [provider[/model]]",
    summary: "show or switch the provider and model",
    run(args, host) {
      const text = args.trim();
      if (text === "") return host.print(host.models());
      const [first, second] = text.split(/[\s/]+/, 2);
      return host.switchModel(first, second);
    },
  },
  { name: "permissions", aliases: ["approvals"], usage: "/permissions [auto|read-only|strict|full-access]", summary: "show or change what is reviewed", run: (args, host) => host.permissions(args.trim() || undefined) },
  {
    name: "redaction",
    usage: "/redaction [on|off]",
    summary: "hide secrets from the model (off by default)",
    run(args, host) {
      const value = args.trim().toLowerCase();
      if (value !== "" && value !== "on" && value !== "off") return host.fail("Usage: /redaction [on|off]");
      return host.redaction(value === "" ? undefined : (value as "on" | "off"));
    },
  },
  { name: "compact", usage: "/compact", summary: "summarise the conversation to free context", run: (_args, host) => host.compact() },
  { name: "new", usage: "/new", summary: "start a new session", run: (_args, host) => host.newSession() },
  { name: "clear", usage: "/clear", summary: "clear the screen and start a new session", run: (_args, host) => host.clearScreen() },
  { name: "resume", usage: "/resume [id|last]", summary: "continue an earlier session", run: (args, host) => host.resume(args.trim() || undefined) },
  { name: "fork", usage: "/fork", summary: "copy this session into a new one and continue there", run: (_args, host) => host.fork() },
  { name: "undo", usage: "/undo", summary: "go back to before your last message", run: (_args, host) => host.undo() },
  {
    name: "rename",
    usage: "/rename <name>",
    summary: "give this session a name",
    run(args, host) {
      if (args.trim() === "") return host.fail("Usage: /rename <name>");
      return host.rename(args.trim());
    },
  },
  { name: "init", usage: "/init", summary: "have the agent write an AGENTS.md for this project", run: (_args, host) => host.runPrompt(INIT_PROMPT) },
  { name: "review", usage: "/review [focus]", summary: "have the agent review the uncommitted changes", run: (args, host) => host.runPrompt(reviewPrompt({ focus: args.trim() })) },
  { name: "diff", usage: "/diff", summary: "show git diff", duringRun: true, run: (_args, host) => host.diff() },
  { name: "goal", usage: "/goal [objective|clear]", summary: "show, set or clear the goal of this session", run: (args, host) => host.goal(args.trim() || undefined) },
  { name: "mcp", usage: "/mcp", summary: "show MCP servers", duringRun: true, run: (_args, host) => host.print(host.mcp()) },
  { name: "exit", aliases: ["quit", "q"], usage: "/exit", summary: "leave", duringRun: true, run: (_args, host) => host.exit() },
];

export interface ParsedSlash {
  name: string;
  args: string;
}

/** A line is a command when it starts with "/" followed by a word and then a space or the end; "/usr/bin/x" is not. */
export function parseSlash(line: string): ParsedSlash | undefined {
  const match = /^\/([A-Za-z?][\w-]*)(?:\s+([\s\S]*))?$/.exec(line.trimEnd());
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase(), args: match[2] ?? "" };
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}

/** Commands whose name starts with what was typed, for the popup. Typing a space ends completion. */
export function complete(input: string): SlashCommand[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export function helpMarkdown(): string {
  const rows = COMMANDS.map((command) => `| \`${command.usage}\` | ${command.summary} |`);
  return ["| Command | What it does |", "|---|---|", ...rows, "", "While the agent works: **Enter** steers it, **Tab** queues a message, **Esc** cancels. `!cmd` runs a shell command yourself."].join("\n");
}
