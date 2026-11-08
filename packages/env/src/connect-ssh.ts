import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { ExecResult } from "@sakura/kernel";
import { createRemoteEnvironment, RemoteConnectionError } from "./remote.ts";
import type { RemoteRunner } from "./remote.ts";

export interface SshOptions {
  /** What to connect to: a name from ~/.ssh/config, or user@host. Authentication, keys and host keys are whatever ssh is set up to do. */
  host: string;
  port?: number;
  identityFile?: string;
  /** Extra ssh options, written as `-o Name=value` (ProxyJump, StrictHostKeyChecking, ...). */
  options?: Record<string, string>;
  /** Seconds to wait for a connection to be made (default 15). */
  connectTimeoutSec?: number;
  /** The ssh program to run (default "ssh"). */
  ssh?: string;
}

export interface SshConnection {
  /** Runs a command on the remote machine over the connection. Rejects with RemoteConnectionError when ssh could not reach it. */
  run: RemoteRunner;
  /** Hangs up and removes what was made on this machine. Safe to call more than once. */
  close(): Promise<void>;
}

/** Output kept from one command, as for a local one. */
const MAX_OUTPUT_CHARS = 20_000_000;

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Runs ssh on this machine and collects what it prints. */
function runSsh(program: string, args: string[], options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined }): Promise<ExecResult & { stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let timedOut = false;
    const keep = (chunk: Buffer, target: "both" | "stderr") => {
      const text = chunk.toString("utf8");
      output += text;
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(output.length - MAX_OUTPUT_CHARS);
      if (target === "stderr") stderr += text;
    };
    child.stdout.on("data", (chunk: Buffer) => keep(chunk, "both"));
    child.stderr.on("data", (chunk: Buffer) => keep(chunk, "stderr"));
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    };
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMs)
        : undefined;
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new RemoteConnectionError(`could not run ${program}: ${error.message}`));
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ exitCode: code, output, timedOut, stderr });
    };
    child.on("close", finish);
    // An ssh that makes the connection leaves a copy of itself behind in the background (the first one does, and so does one that has to make it again), and
    // that copy may keep our pipes open for as long as it lives. So the answer is the ssh we started exiting, with a moment for what it wrote to arrive.
    child.on("exit", (code) =>
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, 100),
    );
  });
}

/**
 * Opens one connection to the machine and runs every command over it. The first ssh logs in (once) and stays in the background; each later ssh finds it
 * through a socket in a directory of ours and only starts a new process on the other side, so a command costs milliseconds and not a login. If the
 * connection dies, the next command makes a new one by itself. Nothing is promised about the connection: when it cannot be reached, the command's
 * result is a RemoteConnectionError and the caller says so.
 */
export async function connectSsh(options: SshOptions): Promise<SshConnection> {
  const program = options.ssh ?? "ssh";
  // sockets have a short length limit (104 characters on macOS), so the directory is under /tmp and the name is a hash
  const directory = await mkdtemp("/tmp/sk-ssh-");
  const control = `${directory}/%C`;
  const common = [
    "-o",
    `ControlPath=${control}`,
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${options.connectTimeoutSec ?? 15}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(options.port !== undefined ? ["-p", String(options.port)] : []),
    ...(options.identityFile !== undefined ? ["-i", options.identityFile] : []),
    ...Object.entries(options.options ?? {}).flatMap(([name, value]) => ["-o", `${name}=${value}`]),
  ];
  let closed = false;

  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    // log in now, so a wrong host or key shows up here and not in the middle of a task
    const opened = await runSsh(program, [...common, "-o", "ControlMaster=yes", "-o", "ControlPersist=10m", "-N", options.host], {});
    if (opened.exitCode !== 0) throw new RemoteConnectionError(`could not connect to ${options.host}: ${opened.stderr.trim() || `ssh exited with ${opened.exitCode}`}`);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const run: RemoteRunner = async (command, runOptions) => {
    if (closed) throw new RemoteConnectionError("the connection was closed");
    const remote = `${runOptions.cwd !== undefined ? `cd ${quote(runOptions.cwd)} && ` : ""}bash -c ${quote(command)}`;
    const result = await runSsh(program, [...common, "-o", "ControlMaster=auto", "-o", "ControlPersist=10m", options.host, remote], { timeoutMs: runOptions.timeoutMs, signal: runOptions.signal });
    // ssh itself exits with 255 when it could not reach the machine; a command that exits with 255 on its own is taken for that too
    if (result.exitCode === 255 && !result.timedOut && !runOptions.signal?.aborted) throw new RemoteConnectionError(result.stderr.trim() || `could not reach ${options.host}`);
    return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut };
  };

  return {
    run,
    async close() {
      if (closed) return;
      closed = true;
      await runSsh(program, [...common, "-O", "exit", options.host], {}).catch(() => undefined);
      await cleanup();
    },
  };
}

/** What the model is told about where its tools run, over ssh. */
export function describeSsh(host: string, cwd: string): string {
  return (
    `a remote machine (${host}), not the computer that runs you. Every command is sent over an SSH connection and starts fresh in ${cwd}: cd and export do not carry over to the next command. ` +
    "The connection can be slow or drop, and a command can fail for reasons that have nothing to do with it, so results are not guaranteed to be repeatable. " +
    "If a tool says the connection failed, the command may or may not have run: look at the current state (list the files, read the output file) before you repeat anything that changes something. " +
    "Files are on the remote machine."
  );
}

/** An environment whose tools run on another machine over ssh. Close it (or dispose of the agent) to hang up. */
export async function createSshEnvironment(options: SshOptions & { cwd: string }) {
  const connection = await connectSsh(options);
  return createRemoteEnvironment({ cwd: options.cwd, run: connection.run, close: connection.close, description: describeSsh(options.host, options.cwd) });
}
