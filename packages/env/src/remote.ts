import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Environment, ExecResult, FileInfo, ProcessHandle } from "@sakura/kernel";
import { RemoteConnectionError } from "./remote-types.ts";
import type { RemoteRunner } from "./remote-types.ts";
import { createStreamedSpawn } from "./remote-stream.ts";
import type { RemoteStreamer } from "./remote-stream.ts";

export { RemoteConnectionError } from "./remote-types.ts";
export type { RemoteRunner } from "./remote-types.ts";

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
const CHUNK = 48_000;

/**
 * An environment on another machine (a container, say) reached only through `run`. Files are read and written
 * with base64 over the shell, and long commands are started detached so they can outlive a single call.
 */
export function createRemoteEnvironment(options: {
  cwd: string;
  run: RemoteRunner;
  /**
   * Optional. With it, every command (`spawn` and `exec`) is one streamed child of the connection and its end is the end of that child; without it the
   * environment starts commands detached through `run` and looks for their exit code from time to time, which is all a runner without a live channel can do.
   */
  stream?: RemoteStreamer;
  /** Called once when the environment is disposed, after its commands were stopped: close the connection the runner uses. */
  close?: () => Promise<void>;
  /** What the model is told about where its tools run (see Environment.description). */
  description?: string;
  /** Where the scripts and logs of started commands are kept on the other machine, and where a background command's output file is. Default /tmp/.sakura-remote, so the working directory is left as the task has it. */
  workDir?: string;
}): Environment {
  const root = posix.resolve("/", options.cwd);
  const workDir = posix.resolve("/", options.workDir ?? "/tmp/.sakura-remote");
  const { run } = options;
  const resolvePath = (path: string): string => (path.startsWith("/") ? posix.normalize(path) : posix.resolve(root, path));
  const running = new Set<ProcessHandle>();
  let counter = 0;
  const prefix = randomBytes(3).toString("hex");

  async function must(command: string): Promise<string> {
    const result = await run(command, { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.output.trim() || `command failed with exit code ${result.exitCode}`);
    return result.output;
  }

  const killing = new Map<ProcessHandle, Promise<void>>();

  function spawnPolled(command: string, spawnOptions: { cwd?: string; signal?: AbortSignal }): ProcessHandle {
    const id = `${prefix}-${++counter}`;
    const log = posix.join(workDir, `${id}.log`);
    const codeFile = posix.join(workDir, `${id}.code`);
    const scriptFile = posix.join(workDir, `${id}.sh`);
    let pid = 0;
    let finished = false;
    let result: ExecResult | undefined;
    let startFailure: RemoteConnectionError | undefined;
    const script = `cd ${quote(spawnOptions.cwd ? resolvePath(spawnOptions.cwd) : root)} || exit 1\n${command}\n`;
    const started = run(
      `mkdir -p ${quote(workDir)} && echo ${Buffer.from(script).toString("base64")} | base64 -d > ${quote(scriptFile)} || exit $?; ` +
        `setsid bash -c ${quote(`bash ${quote(scriptFile)} > ${quote(log)} 2>&1; echo $? > ${quote(codeFile)}`)} > /dev/null 2>&1 & echo $!`,
      { cwd: root },
    ).then(
      (outcome) => {
        if (outcome.exitCode === 0) pid = Number.parseInt(outcome.output.trim().split("\n").at(-1) ?? "", 10) || 0;
      },
      (error: unknown) => {
        if (!(error instanceof RemoteConnectionError)) throw error;
        startFailure = error;
      },
    );

    // Stopping is done once, however often it is asked for, and can be waited for (dispose does).
    const kill = () => {
      if (killing.has(handle)) return;
      killing.set(
        handle,
        started
          .then(() => (pid > 0 ? run(`kill -TERM -- -${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; true`, { cwd: root }) : undefined))
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    };
    spawnOptions.signal?.addEventListener("abort", kill, { once: true });

    /** The connection failed and nothing can be said about how the command ended: say that, and where its output is. */
    const lost = (error: unknown, what: string): unknown => {
      finished = true;
      running.delete(handle);
      return error instanceof RemoteConnectionError
        ? new RemoteConnectionError(`${what} (${error.message}). The command may still be running; its output is being written to ${log} on the remote machine.`)
        : error;
    };

    let done!: Promise<ExecResult>;
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
    done = (async (): Promise<ExecResult> => {
      await started;
      if (startFailure) {
        finished = true;
        running.delete(handle);
        throw new RemoteConnectionError(
          `The connection to the remote machine failed while the command was being started, so it may or may not be running (${startFailure.message}). If it is, its output is being written to ${log} on the remote machine.`,
        );
      }
      if (pid === 0) {
        finished = true;
        running.delete(handle);
        return { exitCode: null, output: "the command could not be started", timedOut: false };
      }
      for (let attempt = 0; ; attempt++) {
        const state = await run(`if [ -f ${quote(codeFile)} ]; then cat ${quote(codeFile)}; elif kill -0 ${pid} 2>/dev/null; then echo running; else echo gone; fi`, {
          cwd: root,
        }).catch((error: unknown) => {
          throw lost(error, "The connection to the remote machine was lost while waiting for the command");
        });
        const text = state.output.trim();
        if (text !== "running") {
          const output = await run(`cat ${quote(log)} 2>/dev/null`, { cwd: root }).catch((error: unknown) => {
            throw lost(error, "The connection to the remote machine was lost while reading the output of the command");
          });
          const exitCode = /^\d+$/.test(text) ? Number(text) : null;
          finished = true;
          running.delete(handle);
          result = { exitCode, output: output.output, timedOut: false };
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt < 8 ? 250 : 1000));
      }
    })();
    done.catch(() => undefined); // a caller that never waits must not cause an unhandled rejection

    running.add(handle);
    return handle;
  }

  const spawn = options.stream ? createStreamedSpawn({ stream: options.stream, run, root, workDir, resolvePath, nextId: () => `${prefix}-${++counter}`, running, killing }) : spawnPolled;

  /** A command run to its end: started like any other, so stopping it (timeout, cancel) stops it on the other side too. */
  async function execStreamed(command: string, execOptions: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult> {
    const handle = spawn(command, { ...(execOptions.cwd !== undefined ? { cwd: execOptions.cwd } : {}), ...(execOptions.signal ? { signal: execOptions.signal } : {}) });
    let timedOut = false;
    const timer =
      execOptions.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            handle.kill();
          }, execOptions.timeoutMs)
        : undefined;
    try {
      return { ...(await handle.wait()), timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  let disposed = false;
  return {
    cwd: root,
    ...(options.description !== undefined ? { description: options.description } : {}),
    resolve: resolvePath,
    async readFile(path) {
      const output = await must(`set -o pipefail; base64 < ${quote(resolvePath(path))} | tr -d '\\n'`);
      return new Uint8Array(Buffer.from(output.trim(), "base64"));
    },
    async writeFile(path, data) {
      const target = resolvePath(path);
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      const temp = `${target}.af-${randomBytes(4).toString("hex")}`;
      await must(`mkdir -p ${quote(posix.dirname(target))} && : > ${quote(temp)}`);
      const encoded = bytes.toString("base64");
      for (let offset = 0; offset < encoded.length; offset += CHUNK) {
        await must(`printf %s ${quote(encoded.slice(offset, offset + CHUNK))} >> ${quote(temp)}`);
      }
      await must(`base64 -d < ${quote(temp)} > ${quote(target)} && rm -f ${quote(temp)}`);
    },
    async stat(path): Promise<FileInfo | undefined> {
      const p = quote(resolvePath(path));
      const output = (await must(`if [ -d ${p} ]; then echo dir 0; elif [ -f ${p} ]; then echo file $(wc -c < ${p}); else echo none 0; fi`)).trim();
      const [kind, size] = output.split(/\s+/);
      if (kind === "none") return undefined;
      return { isFile: kind === "file", isDirectory: kind === "dir", size: Number(size) || 0 };
    },
    async list(path) {
      const output = await must(`ls -A1 ${quote(resolvePath(path))}`);
      return output.split("\n").filter(Boolean).sort();
    },
    spawn,
    exec: (command, execOptions) =>
      options.stream
        ? execStreamed(command, execOptions)
        : run(command, {
            cwd: execOptions.cwd ? resolvePath(execOptions.cwd) : root,
            ...(execOptions.timeoutMs !== undefined ? { timeoutMs: execOptions.timeoutMs } : {}),
            ...(execOptions.signal ? { signal: execOptions.signal } : {}),
          }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      const handles = [...running];
      for (const handle of handles) handle.kill();
      await Promise.all(handles.map((handle) => killing.get(handle)));
      // the scripts, logs and exit codes of this session are of no use to anyone afterwards
      if (counter > 0) await run(`rm -f ${quote(posix.join(workDir, `${prefix}-`))}*`, { cwd: root }).catch(() => undefined);
      await options.close?.();
    },
  };
}
