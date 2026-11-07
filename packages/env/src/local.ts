import { spawn as spawnProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Environment, ExecResult, FileInfo, ProcessHandle } from "@sakura/kernel";

const MAX_OUTPUT_CHARS = 20_000_000;
const KILL_GRACE_MS = 1500;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is already gone
  }
}

// Commands run in their own process group, so they would outlive a host process that is stopped without closing the environment
// (Ctrl-C, process.exit, a script that ends while a background command still runs). Every group still running is stopped when the host exits.
const liveGroups = new Set<number>();
let exitHooked = false;

function stopAllGroups(): void {
  for (const pid of liveGroups) killGroup(pid, "SIGKILL");
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", stopAllGroups);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const onSignal = () => {
      stopAllGroups();
      process.removeListener(signal, onSignal);
      // with no other handler the signal would have ended the process; our handler must not turn that into "keeps running"
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

/** The environment tools run in when there is no sandbox: the local machine. */
export function createLocalEnvironment(cwd: string): Environment {
  const root = resolve(cwd);
  const resolvePath = (path: string): string => (isAbsolute(path) ? resolve(path) : resolve(root, path));
  const running = new Set<ProcessHandle>();
  let outputDir: Promise<string> | undefined;
  let counter = 0;
  const nextOutputFile = async (): Promise<string> => {
    outputDir ??= mkdtemp(join(tmpdir(), "sakura-env-"));
    return join(await outputDir, `command-${++counter}.log`);
  };

  function start(command: string, options: { cwd?: string; signal?: AbortSignal }): ProcessHandle {
    const child = spawnProcess("/bin/bash", ["-c", command], {
      cwd: options.cwd ? resolvePath(options.cwd) : root,
      detached: true, // its own process group, so the whole tree can be stopped
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid ?? -1;
    if (child.pid !== undefined) {
      hookExit();
      liveGroups.add(child.pid);
    }
    let output = "";
    let finished = false;
    let killScheduled = false;
    const fileReady = nextOutputFile().then((path) => ({ path, stream: createWriteStream(path) }));
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(output.length - MAX_OUTPUT_CHARS);
      void fileReady.then(({ stream }) => stream.write(chunk));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const kill = () => {
      killGroup(child.pid, "SIGTERM");
      if (!killScheduled) {
        killScheduled = true;
        setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
      }
    };
    if (options.signal?.aborted) kill();
    options.signal?.addEventListener("abort", kill, { once: true });

    let outputFile = "";
    const done = new Promise<ExecResult>((resolveResult) => {
      let settled = false;
      const finish = async (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", kill);
        child.stdout.destroy();
        child.stderr.destroy();
        const file = await fileReady;
        await new Promise<void>((closed) => file.stream.end(closed));
        finished = true;
        if (child.pid !== undefined) liveGroups.delete(child.pid);
        running.delete(handle);
        resolveResult({ exitCode, output, timedOut: false });
      };
      child.on("error", (error) => {
        output += `\n${error.message}`;
        void finish(null);
      });
      // A command that leaves a background process holding the pipes open must not make us wait for it:
      // once the shell itself has exited, give the pipes a moment to drain and finish.
      child.on("exit", (code) => setTimeout(() => void finish(code), 50));
      child.on("close", (code) => void finish(code));
    });
    void fileReady.then(({ path }) => {
      outputFile = path;
    });

    const handle: ProcessHandle = {
      pid,
      get outputFile() {
        return outputFile;
      },
      wait: () => done,
      kill,
      get finished() {
        return finished;
      },
    };
    running.add(handle);
    return handle;
  }

  return {
    cwd: root,
    resolve: resolvePath,
    readFile: async (path) => new Uint8Array(await readFile(resolvePath(path))),
    async writeFile(path, data) {
      const target = resolvePath(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async stat(path): Promise<FileInfo | undefined> {
      try {
        const info = await stat(resolvePath(path));
        return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async list(path) {
      return (await readdir(resolvePath(path))).sort();
    },
    spawn: start,
    async exec(command, options): Promise<ExecResult> {
      const handle = start(command, options.signal ? { ...(options.cwd ? { cwd: options.cwd } : {}), signal: options.signal } : options.cwd ? { cwd: options.cwd } : {});
      let timedOut = false;
      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              handle.kill();
            }, options.timeoutMs)
          : undefined;
      const result = await handle.wait();
      if (timer) clearTimeout(timer);
      return { ...result, timedOut };
    },
    async dispose() {
      for (const handle of [...running]) handle.kill();
      await Promise.all([...running].map((handle) => handle.wait()));
    },
  };
}
