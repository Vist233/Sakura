import { posix } from "node:path";
import type { ExecResult, ProcessHandle } from "@sakura/kernel";
import { RemoteConnectionError } from "./remote-types.ts";
import type { RemoteRunner } from "./remote-types.ts";

/**
 * Runs one command on the other side as a child that lives as long as the command is watched, and hands over what it prints as it is printed. Resolves
 * with the exit code of that child (null when it was stopped by a signal) and what it wrote to its own error stream, which is the transport's talk (ssh
 * says why it could not connect) and never the command's. Rejects with a RemoteConnectionError when the child could not be started at all.
 */
export type RemoteStreamer = (command: string, options: { cwd?: string; signal?: AbortSignal; onData(text: string): void }) => Promise<{ exitCode: number | null; stderr: string }>;

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Output kept from one command, as for a local one. */
const MAX_OUTPUT_CHARS = 20_000_000;
/** After a stop was asked for, how long the connection gets to report the end before the local child is killed. */
const STOP_GRACE_MS = 4000;
/** What the model sees of a command that was lost in the middle. */
const TAIL_LINES = 20;

export interface StreamedSpawnDependencies {
  stream: RemoteStreamer;
  /** One short command over the same connection (used to stop a command). */
  run: RemoteRunner;
  root: string;
  workDir: string;
  resolvePath(path: string): string;
  nextId(): string;
  running: Set<ProcessHandle>;
  killing: Map<ProcessHandle, Promise<void>>;
}

/**
 * The shell text one streamed command is sent as. It writes the script, starts it detached (own session, output into a log file, so it survives the
 * connection and the log can be read afterwards), prints the process group id, then copies the log to its own output as the log grows. When the command
 * has ended and the log is copied to the last byte, it prints the exit code after a marker. `wait` gives the exit code without anyone looking for it.
 */
export function launcherFor(options: { id: string; command: string; cwd: string; workDir: string }): string {
  const { id, workDir } = options;
  const script = posix.join(workDir, `${id}.sh`);
  const log = posix.join(workDir, `${id}.log`);
  const stop = posix.join(workDir, `${id}.stop`);
  const body = `cd ${quote(options.cwd)} || exit 1\n${options.command}\n`;
  const detached = `bash ${quote(script)} > ${quote(log)} 2>&1; code=$?; exit $code`;
  return [
    `mkdir -p ${quote(workDir)} && echo ${Buffer.from(body).toString("base64")} | base64 -d > ${quote(script)} && : > ${quote(log)} && rm -f ${quote(stop)} || exit 126`,
    `setsid bash -c ${quote(detached)} < /dev/null > /dev/null 2>&1 &`,
    "main=$$ job=$!",
    `printf '@@${id}-pid %s\\n' "$job"`,
    // copy the log as it grows; the end is known when the stop file exists (or the shell that started this is gone) AND nothing more was written after that was seen
    `( sent=0; while :; do ended=0; [ -e ${quote(stop)} ] && ended=1; kill -0 "$main" 2>/dev/null || ended=1; size=$(wc -c < ${quote(log)}); if [ "$size" -gt "$sent" ]; then tail -c +$((sent+1)) ${quote(log)} | head -c $((size-sent)); sent=$size; continue; fi; [ $ended = 1 ] && break; sleep 0.05; done ) &`,
    "follower=$!",
    'wait "$job"; code=$?',
    `: > ${quote(stop)}`,
    'wait "$follower"',
    `printf '\\n@@${id}-exit %s\\n' "$code"`,
    // the command's own code is in the line above; the child ends with 0, so that an ssh that ends with 255 can only mean that the connection failed
    "exit 0",
  ].join("\n");
}

/** `kill` text for the group of a command: ask nicely, then insist. */
export const stopCommand = (pid: number): string => `kill -TERM -- -${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; true`;

const lastLines = (text: string): string => text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/**
 * `spawn` for an environment that has a streamer. Each command is one child of the connection; the exit code is the end of that child's script, no
 * file is looked at to find it; stopping a command stops its process group on the other side. When the connection is lost the command is NOT followed:
 * it keeps running there (it is detached), and the error says that, where its output is, and that the model must stop and report it.
 */
export function createStreamedSpawn(deps: StreamedSpawnDependencies): (command: string, options: { cwd?: string; signal?: AbortSignal }) => ProcessHandle {
  return (command, spawnOptions) => {
    const id = deps.nextId();
    const log = posix.join(deps.workDir, `${id}.log`);
    const pidMarker = `@@${id}-pid `;
    const exitMarker = `\n@@${id}-exit `;
    const local = new AbortController();
    let pid = 0;
    let finished = false;
    let stopRequested = false;
    let received = "";
    let pidSeen!: () => void;
    const pidKnown = new Promise<void>((resolve) => {
      pidSeen = resolve;
    });

    const launcher = launcherFor({ id, command, cwd: spawnOptions.cwd ? deps.resolvePath(spawnOptions.cwd) : deps.root, workDir: deps.workDir });

    const kill = () => {
      if (deps.killing.has(handle)) return;
      stopRequested = true;
      deps.killing.set(
        handle,
        (async () => {
          const ended = new Promise<void>(
            (resolve) =>
              void done.then(
                () => resolve(),
                () => resolve(),
              ),
          );
          await Promise.race([pidKnown, ended]);
          if (pid > 0 && !finished) await deps.run(stopCommand(pid), { cwd: deps.root }).catch(() => undefined);
          // the connection normally reports the end now; if it does not, the local child is stopped so that nobody waits for ever
          const timer = setTimeout(() => local.abort(), STOP_GRACE_MS);
          await ended;
          clearTimeout(timer);
        })(),
      );
    };
    spawnOptions.signal?.addEventListener("abort", kill, { once: true });
    if (spawnOptions.signal?.aborted) queueMicrotask(kill);

    const lostMessage = (reason: string): string =>
      `The connection to the remote machine was lost while the command was running (${reason}). The command may still be running or may have finished; its output is being written to ${log} on the remote machine. ` +
      "Stop here and tell the user that the connection was lost, and where that output file is. Do not reconnect or run the command again yourself." +
      (received.trim() !== "" ? `\nLast output received:\n${lastLines(received)}` : "");

    const handle: ProcessHandle = {
      get pid() {
        return pid;
      },
      outputFile: log,
      wait: () => done,
      kill,
      get finished() {
        return finished;
      },
    };

    const done: Promise<ExecResult> = (async (): Promise<ExecResult> => {
      const end = () => {
        finished = true;
        deps.running.delete(handle);
      };
      let outcome: { exitCode: number | null; stderr: string };
      try {
        outcome = await deps.stream(launcher, {
          cwd: deps.root,
          signal: local.signal,
          onData: (text) => {
            received += text;
            if (received.length > MAX_OUTPUT_CHARS) received = received.slice(received.length - MAX_OUTPUT_CHARS);
            if (pid === 0 && received.startsWith(pidMarker) && received.includes("\n")) {
              pid = Number.parseInt(received.slice(pidMarker.length, received.indexOf("\n")), 10) || 0;
              received = received.slice(received.indexOf("\n") + 1);
              pidSeen();
            }
          },
        });
      } catch (error) {
        end();
        pidSeen();
        if (!(error instanceof RemoteConnectionError)) throw error;
        throw new RemoteConnectionError(
          pid === 0
            ? `The connection to the remote machine failed while the command was being started, so it may or may not be running (${error.message}). If it is, its output is being written to ${log} on the remote machine. Stop here and tell the user.`
            : lostMessage(error.message),
        );
      }
      end();
      pidSeen();
      const at = received.lastIndexOf(exitMarker);
      const trailer = at === -1 ? undefined : /^(\d+)\n$/.exec(received.slice(at + exitMarker.length));
      if (at !== -1 && trailer) {
        const code = Number(trailer[1]);
        const output = received.slice(0, at);
        // stopped on request: the number says which signal ended it, which nobody asked about
        return { exitCode: stopRequested && code > 128 ? null : code, output: output.length > MAX_OUTPUT_CHARS ? output.slice(output.length - MAX_OUTPUT_CHARS) : output, timedOut: false };
      }
      if (pid === 0) return { exitCode: null, output: `the command could not be started${outcome.stderr.trim() ? `: ${outcome.stderr.trim()}` : ""}`, timedOut: false };
      throw new RemoteConnectionError(lostMessage(outcome.stderr.trim() || `the connection ended with ${outcome.exitCode === null ? "a signal" : `exit code ${outcome.exitCode}`}`));
    })();
    done.catch(() => undefined); // a caller that never waits must not cause an unhandled rejection

    deps.running.add(handle);
    return handle;
  };
}
