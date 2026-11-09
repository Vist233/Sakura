// Blocks of the transcript to terminal lines: user messages, rendered Markdown replies, tool cards, notices.
import { createPalette, displayWidth, truncate, wrapAnsi } from "../ansi.ts";
import { renderMarkdown } from "../markdown.ts";
import type { Block, ToolBlock } from "../transcript.ts";

export interface ViewOptions {
  width: number;
  color: boolean;
  /** The launch directory; paths under it are shown relative to it. */
  cwd?: string;
}

/** Shows paths under the launch directory relative to it ("/work/a/b.py" as "b.py" when the directory is "/work/a"). */
export function relativize(text: string, cwd: string | undefined): string {
  if (!cwd || cwd === "/") return text;
  const escaped = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}/`, "g"), "").replace(new RegExp(`${escaped}(?![\\w./-])`, "g"), ".");
}

export function renderBlock(block: Block, options: ViewOptions): string[] {
  const pal = createPalette(options.color);
  const width = Math.max(20, options.width);
  switch (block.kind) {
    case "user":
      return prefixed(wrapAnsi(block.text, width - 2), pal.bold(pal.cyan("› ")), "  ");
    case "assistant":
      return prefixed(renderMarkdown(block.text, { width: width - 2, color: options.color }), block.first ? pal.magenta("• ") : "  ", "  ");
    case "tool":
      return renderTool(block, options);
    case "compaction":
      return [pal.dim(`── context compacted (${block.tokensBefore.toLocaleString("en-US")} tokens before) ──`)];
    case "info":
      return renderMarkdown(block.markdown, { width, color: options.color });
    case "notice": {
      const mark = block.level === "error" ? pal.red("✗ ") : block.level === "warn" ? pal.yellow("! ") : pal.dim("ℹ ");
      const style = block.level === "error" ? pal.red : block.level === "warn" ? pal.yellow : pal.dim;
      return prefixed(wrapAnsi(style(block.text), width - 2), mark, "  ");
    }
    case "shell": {
      const head = `${pal.bold("$ ")}${pal.bold(block.command)}`;
      const body = block.output.map((line) => pal.dim(`  ${line}`));
      const more = block.hidden > 0 ? [pal.dim(`  … +${block.hidden} lines`)] : [];
      const exit = block.exitCode === 0 ? [] : [pal.red(`  exit code ${block.exitCode ?? "unknown (killed)"}`)];
      return [head, ...body, ...more, ...exit];
    }
  }
}

/** The first line of a tool card on its own, cut to the width (for progress lines). */
export function toolHeadline(block: ToolBlock, options: ViewOptions): string {
  return truncate(toolHead(block, options), Math.max(20, options.width));
}

function toolHead(block: ToolBlock, options: ViewOptions): string {
  const pal = createPalette(options.color);
  const mark = block.status === "ok" ? pal.green("✓") : block.status === "running" ? pal.cyan("…") : block.status === "denied" ? pal.yellow("⊘") : pal.red("✗");
  const detail =
    block.status === "error" && block.exitCode !== undefined
      ? pal.red(` (exit ${block.exitCode})`)
      : block.status === "denied"
        ? pal.yellow(` denied by review${block.review ? ` (${block.review.decidedBy})` : ""}`)
        : "";
  const reviewed = block.status !== "denied" && block.review?.outcome === "allow" && block.review.decidedBy === "reviewer" ? pal.dim(" · review ok") : "";
  return `${mark} ${pal.bold(block.name)} ${relativize(block.summary, options.cwd)}${detail}${reviewed}`;
}

function renderTool(block: ToolBlock, options: ViewOptions): string[] {
  const pal = createPalette(options.color);
  const width = Math.max(20, options.width);
  const head = wrapAnsi(toolHead(block, options), width);
  const diff = (block.diff ?? []).map((line) => (line.startsWith("-") ? pal.red(`  ${line}`) : pal.green(`  ${line}`)));
  const reason = block.status === "denied" && block.review?.reason ? [pal.yellow(`  ${block.review.reason}`)] : [];
  const output = block.status === "denied" ? [] : block.output.map((line) => pal.dim(`  │ ${relativize(line, options.cwd)}`));
  const more = block.hidden > 0 ? [pal.dim(`  │ … +${block.hidden} lines`)] : [];
  return [...head, ...diff, ...reason, ...output, ...more];
}

function prefixed(lines: string[], first: string, rest: string): string[] {
  return lines.map((line, index) => (line === "" && index > 0 ? "" : `${index === 0 ? first : rest}${line}`));
}

/** How many blank lines go between two printed blocks. */
export function spacingBetween(previous: Block | undefined, next: Block): number {
  if (!previous) return 0;
  if ((previous.kind === "tool" && next.kind === "tool") || (previous.kind === "notice" && next.kind === "notice")) return 0;
  return 1;
}

export interface BannerInfo {
  version: string;
  model: string;
  provider: string;
  cwd: string;
  permissions: string;
  resumed: string | undefined;
}

/** The box shown when the session starts. */
export function renderBanner(info: BannerInfo, options: ViewOptions): string[] {
  const pal = createPalette(options.color);
  const rows = [
    `${pal.bold(pal.magenta("✿ Sakura Terminal"))} ${pal.dim(`(v${info.version})`)}`,
    "",
    `${pal.dim("model:      ")}${info.model} ${pal.dim(`via ${info.provider}`)}`,
    `${pal.dim("directory:  ")}${info.cwd}`,
    `${pal.dim("review:     ")}${info.permissions === "full-access" ? "off" : `on (${info.permissions})`}`,
    ...(info.resumed ? [`${pal.dim("session:    ")}resumed ${info.resumed}`] : []),
  ];
  const inner = Math.min(Math.max(...rows.map(visibleLength)), Math.max(20, options.width - 4));
  rows.forEach((row, index) => {
    if (visibleLength(row) > inner) rows[index] = truncate(row, inner);
  });
  const border = (left: string, right: string) => pal.dim(`${left}${"─".repeat(inner + 2)}${right}`);
  return [border("╭", "╮"), ...rows.map((row) => `${pal.dim("│")} ${row}${" ".repeat(Math.max(0, inner - visibleLength(row)))} ${pal.dim("│")}`), border("╰", "╯"), pal.dim("  /help lists commands · Enter sends · Esc cancels · Ctrl-C twice leaves")];
}

function visibleLength(text: string): number {
  return displayWidth(text);
}
