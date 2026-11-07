import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Environment, ExecResult, FileInfo, ProcessHandle } from "@sakura/kernel";

/** The one thing a remote environment needs: a way to run a shell command somewhere else and get its output back. */
export type RemoteRunner = (command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
const CHUNK = 48_000;

/**
 * An environment on another machine (a container, say) reached only through `run`. Files are read and written
 * with base64 over the shell, and long commands are started detached so they can outlive a single call.
 */
export function createRemoteEnvironment(options: { cwd: string; run: RemoteRunner }): Environment {
  const root = posix.resolve("/", options.cwd);
  const workDir = posix.join(root, ".sakura", "remote");
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

  function spawn(command: string, spawnOptions: { cwd?: string; signal?: AbortSignal }): ProcessHandle {
    const id = `${prefix}-${++counter}`;
    const log = posix.join(workDir, `${id}.log`);
    const codeFile = posix.join(workDir, `${id}.code`);
    const scriptFile = posix.join(workDir, `${id}.sh`);
    let pid = 0;
    let finished = false;
    let result: ExecResult | undefined;
    const script = `cd ${quote(spawnOptions.cwd ? resolvePath(spawnOptions.cwd) : root)} || exit 1\n${command}\n`;
    const started = run(
      `mkdir -p ${quote(workDir)} && echo ${Buffer.from(script).toString("base64")} | base64 -d > ${quote(scriptFile)} || exit $?; ` +
        `setsid bash -c ${quote(`bash ${quote(scriptFile)} > ${quote(log)} 2>&1; echo $? > ${quote(codeFile)}`)} > /dev/null 2>&1 & echo $!`,
      { cwd: root },
    ).then((outcome) => {
      if (outcome.exitCode === 0) pid = Number.parseInt(outcome.output.trim().split("\n").at(-1) ?? "", 10) || 0;
    });

    const kill = () => {
      void started.then(() => (pid > 0 ? run(`kill -TERM -- -${pid} 2>/dev/null; sleep 1; kill -KILL -- -${pid} 2>/dev/null; true`, { cwd: root }) : undefined)).catch(() => undefined);
    };
    spawnOptions.signal?.addEventListener("abort", kill, { once: true });

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
      if (pid === 0) {
        finished = true;
        running.delete(handle);
        return { exitCode: null, output: "the command could not be started", timedOut: false };
      }
      for (let attempt = 0; ; attempt++) {
        const state = await run(`if [ -f ${quote(codeFile)} ]; then cat ${quote(codeFile)}; elif kill -0 ${pid} 2>/dev/null; then echo running; else echo gone; fi`, {
          cwd: root,
        });
        const text = state.output.trim();
        if (text !== "running") {
          const output = await run(`cat ${quote(log)} 2>/dev/null`, { cwd: root });
          const exitCode = /^\d+$/.test(text) ? Number(text) : null;
          finished = true;
          running.delete(handle);
          result = { exitCode, output: output.output, timedOut: false };
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt < 8 ? 250 : 1000));
      }
    })();

    running.add(handle);
    return handle;
  }

  return {
    cwd: root,
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
      run(command, {
        cwd: execOptions.cwd ? resolvePath(execOptions.cwd) : root,
        ...(execOptions.timeoutMs !== undefined ? { timeoutMs: execOptions.timeoutMs } : {}),
        ...(execOptions.signal ? { signal: execOptions.signal } : {}),
      }),
    async dispose() {
      for (const handle of [...running]) handle.kill();
    },
  };
}
