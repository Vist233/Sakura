// Non-interactive mode (`exec`): run one prompt to the end, with no screen. Progress goes to stderr, the final reply to
// stdout as Markdown (rendered for a terminal, raw for a pipe), or every event as a JSON line with --json.
import { writeFile } from "node:fs/promises";
import { renderMarkdown } from "./markdown.ts";
import { createController } from "./session-controller.ts";
import type { ControllerDeps, Surface } from "./session-controller.ts";
import { createTranscript, textOf } from "./transcript.ts";
import { renderBlock, toolHeadline } from "./tui/transcript-view.ts";
import type { Event, RunResult } from "./framework.ts";

export interface Writer {
  write(text: string): unknown;
  columns?: number;
}

export interface ExecOptions {
  prompt: string;
  /** One JSON object per line on stdout. */
  json: boolean;
  /** Render the final Markdown with styles (a terminal) instead of writing it as it is (a pipe). */
  render: boolean;
  /** No progress lines on stderr. */
  quiet: boolean;
  color: boolean;
  outputLastMessage?: string | undefined;
  resume?: string | undefined;
}

export interface ExecDeps {
  controller: Omit<ControllerDeps, "transcript" | "surface">;
  stdout: Writer;
  stderr: Writer;
  /** Called with a function that cancels the run; the caller wires it to SIGINT. */
  onCancelable?: (cancel: () => void) => void;
}

const SILENT_SURFACE: Surface = {
  changed: () => undefined,
  pickSession: async () => undefined,
  clearScreen: () => undefined,
  prefill: () => undefined,
  exit: () => undefined,
};

export function exitCodeFor(result: RunResult): number {
  if (result.reason === "done") return 0;
  if (result.reason === "cancelled") return 130;
  if (result.reason === "paused") return 2;
  return 1;
}

export async function runExec(options: ExecOptions, deps: ExecDeps): Promise<number> {
  const transcript = createTranscript();
  // a one-shot run ends with its answer, so nothing could wake it later
  const controller = createController({ ...deps.controller, settings: { ...deps.controller.settings, schedule: { ...deps.controller.settings.schedule, enabled: false } }, transcript, surface: SILENT_SURFACE });
  try {
    await controller.start(options.resume !== undefined ? { resume: options.resume } : {});
  } catch (error) {
    deps.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  deps.onCancelable?.(() => controller.cancel());

  const meta = controller.currentMeta();
  const info = controller.statusInfo();
  if (options.json) deps.stdout.write(`${JSON.stringify({ type: "session", id: meta?.id, provider: info.provider, model: info.model, cwd: info.cwd, permissions: info.permissions, redaction: info.redaction })}\n`);

  let finalMessage = "";
  controller.driver.onEvent((event: Event) => {
    if (options.json) deps.stdout.write(`${JSON.stringify(event)}\n`);
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = textOf(event.message.content);
      if (text.trim() !== "") finalMessage = text;
    }
  });
  // Progress is optional; a warning or an error (a retry, a failure) is always shown.
  transcript.subscribe((change) => {
    if (change.type !== "commit") return;
    const block = change.block;
    if (options.quiet && !(block.kind === "notice" && block.level !== "info")) return;
    if (block.kind === "tool" || block.kind === "notice" || block.kind === "compaction") {
      const view = { width: 120, color: false, cwd: deps.controller.cwd };
      deps.stderr.write(`${block.kind === "tool" ? toolHeadline(block, view) : renderBlock(block, view).join("\n")}\n`);
    }
  });

  let result: RunResult;
  try {
    result = await controller.runPrompt(options.prompt);
  } catch (error) {
    result = { reason: "error", error: (error as Error).message };
  }

  if (options.json) deps.stdout.write(`${JSON.stringify({ type: "result", ...result, finalMessage })}\n`);
  else if (finalMessage !== "") {
    const text = options.render ? renderMarkdown(finalMessage, { width: Math.min(deps.stdout.columns ?? 100, 120), color: options.color }).join("\n") : finalMessage;
    deps.stdout.write(`${text}\n`);
  }
  if (result.reason === "error") deps.stderr.write(`Error: ${result.error ?? "unknown"}\n`);
  else if (result.reason === "paused") deps.stderr.write(`The run was paused (${result.pause ?? "unknown"}).\n`);
  else if (result.reason === "cancelled") deps.stderr.write("Cancelled.\n");
  if (options.outputLastMessage) await writeFile(options.outputLastMessage, `${finalMessage}\n`);
  await controller.close();
  return exitCodeFor(result);
}
