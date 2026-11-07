import type { Tool, ToolResult } from "@sakura/kernel";
import { DEFAULT_FOLD, foldTail } from "../fold.ts";
import { ArgumentError, optionalBoolean, optionalNumber, requireString } from "./args.ts";

export interface BashOptions {
  /** After this long a command that is still running is moved to the background. Default 120 s. */
  softTimeoutMs?: number;
  /** How long a command started with `background: true` is watched before it is left to run (so that a command that fails at once is reported). Default 1 s. */
  backgroundGraceMs?: number;
}

/** A command that starts with `sleep N` is waiting on purpose, so it gets N more seconds before it moves to the background. */
export function softLimitFor(command: string, base: number): number {
  const match = command.match(/^\s*sleep\s+(\d+(?:\.\d+)?)/);
  return match ? base + Number(match[1]) * 1000 : base;
}

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

/*
 * Description adapted from Pi's bash tool (MIT, Copyright (c) 2025 Mario Zechner; see THIRD_PARTY_NOTICES.md).
 */
export function createBashTool(options: BashOptions = {}): Tool {
  const softBase = options.softTimeoutMs ?? 120_000;
  const graceMs = options.backgroundGraceMs ?? 1000;
  return {
    name: "bash",
    description:
      "Execute a shell command in the current working directory. Returns stdout, stderr and the exit code. " +
      "Output is truncated to the last 2000 lines or 50KB, whichever is hit first; if truncated, the full output is saved to a file and its path is shown. " +
      "Commands run without a terminal and cannot read input: always use non-interactive flags. " +
      "A command that is still running after 120 seconds is moved to the background. You then receive its pid, the path of its output file and how to stop it. " +
      "Set `background: true` to start a server or a long job and return at once; you are told when it ends. " +
      "To wait for something, run `sleep N`; a command that starts with `sleep N` gets N extra seconds before it is moved to the background. " +
      "Optional `timeout` (seconds) kills the command when it is reached; there is no default timeout.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        timeout: { type: "number", description: "Kill the command after this many seconds" },
        background: { type: "boolean", description: "Start the command and return at once, without waiting for it to end" },
      },
      required: ["command"],
    },
    effect: "exec",
    replay: "never",
    async execute(args, { env, signal, watch }) {
      try {
        const command = requireString(args, "command");
        const timeout = optionalNumber(args, "timeout", 0);
        const background = optionalBoolean(args, "background") === true;
        const handle = env.spawn(command, { signal });

        let timedOut = false;
        const hardTimer =
          timeout !== undefined
            ? setTimeout(
                () => {
                  timedOut = true;
                  handle.kill();
                },
                Math.round(timeout * 1000),
              )
            : undefined;
        const soft = background ? graceMs : softLimitFor(command, softBase); // in the background it still gets a moment, so a command that fails at once is reported as a failure
        let softTimer: NodeJS.Timeout | undefined;
        const raced = await Promise.race([
          handle.wait().then((result) => ({ background: false as const, result })),
          new Promise<{ background: true }>((resolve) => {
            softTimer = setTimeout(() => resolve({ background: true }), soft);
          }),
        ]);
        clearTimeout(softTimer);

        if (raced.background) {
          // the hard timeout, if one was given, keeps running and still stops the command
          // tell the agent when it ends, so it does not have to keep looking at the output file
          const ended = watch(`background command (pid ${handle.pid})`);
          void handle.wait().then((finished) => {
            const how = finished.timedOut || timedOut ? "was stopped by its timeout" : finished.exitCode === null ? "was stopped" : `finished with exit code ${finished.exitCode}`;
            ended(`The background command (pid ${handle.pid}) ${how}. Its output is in ${handle.outputFile}.`);
          });
          const seen = await env.readFile(handle.outputFile).then(
            (bytes) => new TextDecoder().decode(bytes),
            () => "",
          );
          const tail = foldTail(seen, { maxLines: 20, maxBytes: 4000 }).text;
          return text(
            (background
              ? "The command was started in the background and is still running.\n"
              : `The command was still running after ${Math.round(soft / 1000)} seconds, so it was moved to the background.\n`) +
              `pid: ${handle.pid}\nOutput is being written to: ${handle.outputFile}\n` +
              `To check progress use read on that file; to wait run \`sleep N\`; to stop it run \`kill -- -${handle.pid}\`.` +
              (tail ? `\n\nOutput so far (last lines):\n${tail}` : ""),
          );
        }

        if (hardTimer) clearTimeout(hardTimer);
        const { result } = raced;
        const folded = foldTail(result.output, DEFAULT_FOLD);
        let body = folded.text === "" ? "(no output)" : folded.text;
        if (folded.truncated) {
          body = `[Output truncated: showing the last ${folded.shownLines} of ${folded.totalLines} lines. Full output: ${handle.outputFile}]\n${body}`;
        }
        if (timedOut) return text(`${body}\n\nCommand timed out after ${timeout} seconds.`, true);
        if (result.exitCode !== 0) return text(`${body}\n\nCommand exited with code ${result.exitCode ?? "unknown (killed)"}.`, true);
        return text(body);
      } catch (error) {
        if (error instanceof ArgumentError) return text(error.message, true);
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}

export const bashTool = createBashTool();
