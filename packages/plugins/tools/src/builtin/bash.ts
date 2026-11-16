import type { Tool, ToolContext, ToolResult } from "@sakura/kernel";
import { DEFAULT_FOLD, foldTail } from "../fold.ts";
import { ArgumentError, optionalBoolean, optionalNumber, requireString } from "./args.ts";

export interface BashOptions {
  /** After this long a command in the foreground that is still running is interrupted. Default 600 s. */
  softTimeoutMs?: number;
  /** The time left for the whole run, if it has a limit. A command in the foreground is never given more than this (at least one second). */
  remainingMs?: () => number | undefined;
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
  const softBase = options.softTimeoutMs ?? 600_000;
  const graceMs = options.backgroundGraceMs ?? 1000;
  return {
    name: "bash",
    description:
      "Execute a shell command in the current working directory. Returns stdout, stderr and the exit code. " +
      "Output is truncated to the last 2000 lines or 50KB, whichever is hit first; if truncated, the full output is saved to a file and its path is shown. " +
      "Commands run without a terminal and cannot read input: always use non-interactive flags. " +
      "Commands run in one shell that stays: cd, export, source and functions carry over to the next command. A command that is still running after 600 seconds (or when the time left for the run is used up) is interrupted and what it printed so far is returned; use `background: true` for a long job. " +
      "Set `background: true` to start a server or a long job and return at once; you are told when it ends. " +
      "To wait for something, run `sleep N`; a command that starts with `sleep N` gets N extra seconds. " +
      "Optional `timeout` (seconds) replaces the 600 seconds: the command is interrupted when it is reached. " +
      "The exit code belongs to the shell command. For a job owned by another service, record its ID and check its own exit status. " +
      "A command that runs in the background tells you when it ends, in your next turn. Set `wake: true` to be woken up for it even if you have nothing else to do by then (to act on the result when it ends), or `wake: false` if you do not need to be. If you leave it out, the application's own setting applies.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        timeout: { type: "number", description: "Kill the command after this many seconds" },
        background: { type: "boolean", description: "Start the command and return at once, without waiting for it to end" },
        wake: { type: "boolean", description: "For a command that runs in the background: wake you up when it ends (true), or not (false)" },
      },
      required: ["command"],
    },
    effect: "exec",
    replay: "never",
    async execute(args, { env, signal, watch, callId }) {
      try {
        const command = requireString(args, "command");
        const timeout = optionalNumber(args, "timeout", 0);
        const background = optionalBoolean(args, "background") === true;
        const wake = optionalBoolean(args, "wake");
        if (background) return await startInBackground(command, wake, timeout, { env, signal, watch });

        // in the foreground the command runs in the environment's shell that stays; one that runs too long is interrupted and what it printed is returned
        const wanted = timeout !== undefined ? Math.round(timeout * 1000) : softLimitFor(command, softBase);
        const left = options.remainingMs?.();
        const limitMs = left === undefined ? wanted : Math.min(wanted, Math.max(1000, left));
        const capped = limitMs < wanted;
        const result = await env.exec(command, { signal, timeoutMs: limitMs });
        const folded = foldTail(result.output, DEFAULT_FOLD);
        let body = folded.text === "" ? "(no output)" : folded.text;
        if (folded.truncated) {
          const saved = await saveFullOutput(env, callId, result.output);
          body = `[Output truncated: showing the last ${folded.shownLines} of ${folded.totalLines} lines.${saved ? ` Full output: ${saved}` : ""}]\n${body}`;
        }
        if (result.timedOut) {
          return text(
            timeout !== undefined
              ? capped
                ? `${body}\n\nThe command was interrupted after ${Math.round(limitMs / 1000)} seconds because that is all the time left for this run.`
                : `${body}\n\nCommand timed out after ${timeout} seconds.`
              : `${body}\n\nThe command was still running after ${Math.round(limitMs / 1000)} seconds${capped ? " (all the time left for this run)" : ""} and was interrupted; the shell is as it was. ` +
                  "For a long job use `background: true` (you are told when it ends), or give a `timeout` that is long enough.",
            true,
          );
        }
        if (result.exitCode !== 0) return text(`${body}\n\nCommand exited with code ${result.exitCode ?? "unknown (killed)"}.`, true);
        return text(body);
      } catch (error) {
        if (error instanceof ArgumentError) return text(error.message, true);
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  };

  /** A command that runs apart from the shell, so a server or a long job does not hold it. It gets a moment first, so one that fails at once is reported as a failure. */
  async function startInBackground(
    command: string,
    wake: boolean | undefined,
    timeout: number | undefined,
    { env, signal, watch }: Pick<ToolContext, "env" | "signal" | "watch">,
  ): Promise<ToolResult> {
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
    const completion = handle.wait().finally(() => clearTimeout(hardTimer));
    const quick = await Promise.race([completion.then((result) => ({ result })), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), graceMs))]);
    if (quick) {
      const folded = foldTail(quick.result.output, DEFAULT_FOLD);
      const body = folded.text === "" ? "(no output)" : folded.text;
      return quick.result.exitCode === 0 ? text(body) : text(`${body}\n\nCommand exited with code ${quick.result.exitCode ?? "unknown (killed)"}.`, true);
    }
    // tell the agent when it ends, so it does not have to keep looking at the output file
    const ended = watch(`background command (pid ${handle.pid})`, wake === undefined ? undefined : { wake });
    void completion.then(
      (finished) => {
        const how = finished.timedOut || timedOut ? "was stopped by its timeout" : finished.exitCode === null ? "was stopped" : `finished with exit code ${finished.exitCode}`;
        // a command that was stopped because the run was cancelled must not start the agent again: whoever cancelled wanted it to stop
        ended(`The background command (pid ${handle.pid}) ${how}. Its output is in ${handle.outputFile}.`, signal.aborted ? { wake: false } : undefined);
      },
      (error: unknown) => ended(`The background command (pid ${handle.pid}) could not be followed to its end: ${error instanceof Error ? error.message : String(error)}`),
    );
    const seen = await env.readFile(handle.outputFile).then(
      (bytes) => new TextDecoder().decode(bytes),
      () => "",
    );
    const tail = foldTail(seen, { maxLines: 20, maxBytes: 4000 }).text;
    return text(
      "The command was started in the background and is still running.\n" +
        `pid: ${handle.pid}\nOutput is being written to: ${handle.outputFile}\n` +
        `To check progress use read on that file; to wait run \`sleep N\`; to stop it run \`kill -- -${handle.pid}\`.` +
        (tail ? `\n\nOutput so far (last lines):\n${tail}` : ""),
    );
  }
}

/** Keeps what was cut from a long output where the model can read it. Undefined when it cannot be saved. */
async function saveFullOutput(env: ToolContext["env"], callId: string, output: string): Promise<string | undefined> {
  try {
    const path = `.sakura/artifacts/bash-${callId.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
    await env.writeFile(path, output);
    return env.resolve(path);
  } catch {
    return undefined;
  }
}

export const bashTool = createBashTool();
