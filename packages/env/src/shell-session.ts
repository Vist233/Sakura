import { randomBytes } from "node:crypto";
import type { ExecResult } from "@sakura/kernel";

/** One running shell, as a transport gives it: text goes in, text (standard output and error together) comes out. */
export interface ShellProcess {
  write(text: string): void;
  onData(listener: (text: string) => void): void;
  /** Called once when the shell is gone. `error` is set when the way to the shell was lost (a dropped connection), which is not the same as the shell ending; `code` is the shell's own exit code when it ended by itself (`exit 3`). */
  onExit(listener: (info: { error?: Error; code?: number }) => void): void;
  /** Stops the shell and what it started. */
  kill(): void;
}

/** Where a shell runs: this machine, a remote machine over ssh, a container. The protocol in `createShellSession` is the same for all. */
export interface ShellTransport {
  /** Starts `bash` in `cwd`. */
  start(cwd: string): ShellProcess;
  /** Asks the foreground commands of the shell with this pid to stop (SIGINT), or with "KILL" everything below it. The shell itself is not to be stopped by "INT". */
  interrupt(pid: number, signal: "INT" | "KILL"): Promise<void>;
}

export interface ShellRunOptions {
  /** Moves the shell to this directory before the command (and leaves it there, as a person's `cd` would). */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShellSession {
  /**
   * Runs a command in the one shell, after the ones before it. The directory, the variables and the functions of a command are there for the next.
   * Standard error is mixed into the output. At a timeout (or when the signal fires) the foreground command is interrupted and the output so far is returned
   * with `timedOut` set. A shell that is stuck or gone is replaced, and the output says that its state was lost.
   */
  run(command: string, options?: ShellRunOptions): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface ShellSessionOptions {
  /** The directory the first shell starts in. */
  cwd: string;
  /** How long an interrupted command gets to come back to the shell before the shell is stopped and replaced (default 3000). */
  interruptGraceMs?: number;
  /** How long a new shell gets to say it is ready (default 15000). */
  startTimeoutMs?: number;
}

const MAX_OUTPUT_CHARS = 20_000_000;
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
const READY = /__SAKURA_READY_(\d+)__/;
/** The output and a note after it, on a line of its own. */
const withNote = (output: string, note: string): string => (output === "" || output.endsWith("\n") ? `${output}${note}` : `${output}\n${note}`);

/**
 * The command that sends `signal` ("INT" or "KILL") to the foreground commands of the shell with this pid, for a transport that has to do it from another channel
 * (`ssh host <this>`, `docker exec c <this>`). For "KILL" the shell goes too. It does not need pkill: a container without procps is read through /proc.
 */
export function signalChildrenCommand(pid: number, signal: "INT" | "KILL"): string {
  const children = `for f in /proc/[0-9]*/stat; do read -r l < "$f" 2>/dev/null || continue; set -- \${l##*) }; [ "$2" = ${pid} ] || continue; p=\${f#/proc/}; kill -${signal} "\${p%/stat}" 2>/dev/null; done`;
  return `{ pkill -${signal} -P ${pid} 2>/dev/null || { ${children}; }; }${signal === "KILL" ? `; kill -KILL ${pid} 2>/dev/null` : ""}; true`;
}

export const SHELL_LOST_NOTE = "[The shell ended, so its state (working directory, variables, functions) is lost. A new shell starts at the next command.]";
export const SHELL_STUCK_NOTE =
  "[The shell did not come back after the interrupt and was stopped. A new shell starts at the next command; its state (working directory, variables, functions) is lost.]";

interface Live {
  process: ShellProcess;
  pid: number;
  /** What the shell printed that nobody asked for yet. */
  received: string;
  listener: ((text: string) => void) | undefined;
  exited: Promise<{ error?: Error; code?: number }>;
}

/**
 * A shell that stays: `cd`, `export`, `source venv/bin/activate` and functions carry over from one command to the next. Each command is sent as one
 * `eval` of a quoted string (so heredocs and multi-line scripts work), followed by a line that prints a marker with the exit code; the output is what
 * came before the marker. One command at a time. A command cannot read from the shell's input (it would eat the next command): it gets /dev/null.
 */
export function createShellSession(transport: ShellTransport, options: ShellSessionOptions): ShellSession {
  const graceMs = options.interruptGraceMs ?? 3000;
  const startMs = options.startTimeoutMs ?? 15_000;
  let live: Live | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  async function open(): Promise<Live> {
    const shell = transport.start(options.cwd);
    const state: Live = { process: shell, pid: 0, received: "", listener: undefined, exited: undefined as unknown as Promise<{ error?: Error; code?: number }> };
    let gone: (info: { error?: Error; code?: number }) => void = () => undefined;
    state.exited = new Promise((resolve) => {
      gone = resolve;
    });
    shell.onData((text) => {
      state.received += text;
      state.listener?.(text);
    });
    shell.onExit((info) => gone(info));
    // `exec 2>&1` mixes the errors into the output; the INT handler keeps the shell alive when its foreground command is interrupted
    shell.write(`exec 2>&1; set -P; trap ':' INT; printf '__SAKURA_READY_%d__' $$\n`);
    const ready = await waitFor(state, READY, startMs);
    if (typeof ready === "string") {
      shell.kill();
      const { error } = await Promise.race([state.exited, Promise.resolve({} as { error?: Error })]);
      throw error ?? new Error(`the shell did not start${ready === "timeout" ? ` within ${startMs / 1000} seconds` : ""}`);
    }
    state.pid = Number(ready[1]);
    state.received = state.received.slice(ready.index + ready[0].length);
    return state;
  }

  /** Waits until `pattern` shows in what the shell sent (match returned), the shell is gone ("exited") or the time is up ("timeout"). */
  function waitFor(state: Live, pattern: RegExp, ms: number | undefined, abort?: AbortSignal): Promise<RegExpExecArray | "exited" | "timeout" | "aborted"> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: RegExpExecArray | "exited" | "timeout" | "aborted") => {
        clearTimeout(timer);
        state.listener = undefined;
        abort?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const check = () => {
        const match = pattern.exec(state.received);
        if (match) finish(match);
      };
      const onAbort = () => finish("aborted");
      state.listener = check;
      void state.exited.then(() => finish("exited"));
      if (ms !== undefined) timer = setTimeout(() => finish("timeout"), ms);
      if (abort?.aborted) return onAbort();
      abort?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  async function execute(command: string, runOptions: ShellRunOptions): Promise<ExecResult> {
    if (closed) return { exitCode: null, output: "the shell session is closed", timedOut: false };
    if (runOptions.signal?.aborted) return { exitCode: null, output: "", timedOut: false };
    try {
      live ??= await open();
    } catch (error) {
      if (error instanceof Error && error.name === "RemoteConnectionError") throw error;
      return { exitCode: null, output: `the shell could not be started: ${error instanceof Error ? error.message : String(error)}`, timedOut: false };
    }
    const shell = live;
    const id = randomBytes(6).toString("hex");
    const end = new RegExp(`__SAKURA_END_${id}_(\\d+)__`);
    shell.received = "";
    const run = `eval ${quote(command)} </dev/null`;
    const guarded = runOptions.cwd !== undefined ? `if cd ${quote(runOptions.cwd)}; then ${run}; else false; fi` : run;
    shell.process.write(`${guarded}\nprintf '__SAKURA_END_${id}_%d__' $?\n`);

    // The wait ends with the marker, the end of the shell, a timeout or the signal. Output is cut to the last MAX_OUTPUT_CHARS.
    const timeout = new AbortController();
    const timer = runOptions.timeoutMs !== undefined ? setTimeout(() => timeout.abort(), runOptions.timeoutMs) : undefined;
    const stop = new AbortController();
    const forward = () => stop.abort();
    timeout.signal.addEventListener("abort", forward, { once: true });
    runOptions.signal?.addEventListener("abort", forward, { once: true });
    const first = await waitFor(shell, end, undefined, stop.signal);
    clearTimeout(timer);
    timeout.signal.removeEventListener("abort", forward);
    runOptions.signal?.removeEventListener("abort", forward);

    const outputUpTo = (match?: RegExpExecArray): string => {
      const text = match ? shell.received.slice(0, match.index) : shell.received;
      return text.length > MAX_OUTPUT_CHARS ? text.slice(text.length - MAX_OUTPUT_CHARS) : text;
    };
    const timedOut = timeout.signal.aborted;

    if (first !== "exited" && first !== "aborted" && first !== "timeout") {
      return { exitCode: Number(first[1]), output: outputUpTo(first), timedOut: false };
    }
    if (first === "exited") {
      live = undefined;
      const { error, code } = await shell.exited;
      if (error) throw error;
      return { exitCode: code ?? null, output: withNote(outputUpTo(), SHELL_LOST_NOTE), timedOut: false };
    }

    // stopped by the timeout or the signal: interrupt the foreground command and give the shell a moment to come back
    await transport.interrupt(shell.pid, "INT").catch(() => undefined);
    const after = await waitFor(shell, end, graceMs);
    if (after !== "exited" && after !== "timeout" && after !== "aborted") {
      const note = timedOut ? `[Still running after ${(runOptions.timeoutMs ?? 0) / 1000} seconds: interrupted.]` : "[Interrupted.]";
      return { exitCode: Number(after[1]), output: withNote(outputUpTo(after), note), timedOut };
    }
    // the shell did not come back (stuck in a builtin, ignoring the interrupt, or gone): everything below it is stopped and the shell is replaced
    live = undefined;
    await transport.interrupt(shell.pid, "KILL").catch(() => undefined);
    shell.process.kill();
    return { exitCode: null, output: withNote(outputUpTo(), after === "exited" ? SHELL_LOST_NOTE : SHELL_STUCK_NOTE), timedOut };
  }

  return {
    run(command, runOptions = {}) {
      const result = queue.then(() => execute(command, runOptions));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      closed = true;
      await queue.catch(() => undefined);
      const shell = live;
      live = undefined;
      if (shell) {
        await transport.interrupt(shell.pid, "KILL").catch(() => undefined);
        shell.process.kill();
      }
    },
  };
}
