import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { ExecResult } from "@sakura/kernel";
import { createRemoteEnvironment, RemoteConnectionError } from "./remote.ts";
import type { RemoteRunner } from "./remote.ts";
import type { RemoteStreamer } from "./remote-stream.ts";

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
  /**
   * How many commands may be running over the connection at once (default 8). A server accepts only so many sessions on one connection (sshd's
   * MaxSessions is 10 unless changed) and refuses the rest, so the others wait here for a free place. A command that runs in the background keeps its place.
   * Two of the places are kept for short jobs (reading a file, stopping a command), so at most this number minus two commands run at once.
   */
  maxSessions?: number;
}

export interface SshConnection {
  /** Runs a command on the remote machine over the connection. Rejects with RemoteConnectionError when ssh could not reach it. */
  run: RemoteRunner;
  /** Runs a command as a streamed child of the connection: its output arrives as it is produced and the child ends when the command does. */
  stream: RemoteStreamer;
  /** The directory on this machine that holds the socket of the connection (for diagnostics and tests). */
  readonly socketDirectory: string;
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

/** Runs ssh on this machine and passes on what it prints as it prints it. What ssh itself says (its stderr) is kept apart from the command's output. */
function streamSsh(program: string, args: string[], options: { signal?: AbortSignal | undefined; onData(text: string): void }): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => options.onData(text));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    };
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => reject(new RemoteConnectionError(`could not run ${program}: ${error.message}`)));
    // "close" comes after the last byte of both pipes was read, so nothing the command printed is lost
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", stop);
      resolve({ exitCode: code, stderr });
    });
  });
}

/** How long a command waits for a free place before it is given up with an error. */
const SESSION_WAIT_MS = 60_000;

/** A fixed number of places, handed out in the order they were asked for. `take` resolves with the function that gives the place back. */
function createPlaces(count: number) {
  let free = count;
  const waiting: Array<{ grant(): void }> = [];
  const giveBack = () => {
    const next = waiting.shift();
    if (next) next.grant();
    else free++;
  };
  const release = () => {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      giveBack();
    };
  };
  return {
    take(waitMs: number, tooLong: () => Error): Promise<() => void> {
      if (free > 0) {
        free--;
        return Promise.resolve(release());
      }
      return new Promise((resolve, reject) => {
        const entry = {
          grant: () => {
            clearTimeout(timer);
            resolve(release());
          },
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(tooLong());
        }, waitMs);
        waiting.push(entry);
      });
    },
  };
}

/** How often an idle connection is touched, so that it is not given up by ControlPersist while the session is still there (the master is meant to live as long as we do). */
const KEEP_ALIVE_MS = 4 * 60_000;

/**
 * Opens one connection to the machine and runs every command over it. The first ssh logs in (once) and stays in the background; each later ssh finds it
 * through a socket in a directory of ours and only starts a new process on the other side, so a command costs milliseconds and not a login. If the
 * connection dies it is NOT made again: commands are run with ControlMaster=no and ProxyCommand=false, so an ssh that finds no live master has nowhere to
 * go and fails at once (by default, ssh_config(5) says, a client that cannot use the socket makes a connection of its own, silently and with a new login).
 * The result is a RemoteConnectionError that tells the caller to stop and report it.
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

  /** Arguments for one command: through the master or nowhere. Ours come first because with ssh the first value of an option wins over later ones. */
  const throughMaster = (remote: string) => ["-o", "ControlMaster=no", "-o", "ProxyCommand=false", ...common, options.host, remote];
  const goneBecause = (detail: string) => new RemoteConnectionError(`the connection to ${options.host} is gone and is not made again by itself: ${detail || "ssh exited with code 255"}`);
  const remoteCommand = (command: string, cwd: string | undefined) => `${cwd !== undefined ? `cd ${quote(cwd)} && ` : ""}bash -c ${quote(command)}`;
  // Two places stay for short jobs (files, stopping a command), so that commands that run for long cannot keep a command from being stopped.
  const SHORT_PLACES = 2;
  const maxSessions = Math.max(SHORT_PLACES + 1, options.maxSessions ?? 8);
  const commandPlaces = createPlaces(maxSessions - SHORT_PLACES);
  const shortPlaces = createPlaces(SHORT_PLACES);
  const waitForPlace = (places: ReturnType<typeof createPlaces>, limit: number) =>
    places.take(
      SESSION_WAIT_MS,
      () =>
        new RemoteConnectionError(
          `too many commands are running at once over the connection to ${options.host} (at most ${limit}); none ended within ${SESSION_WAIT_MS / 1000} seconds. Wait for one to finish or stop one, then try again.`,
        ),
    );

  const run: RemoteRunner = async (command, runOptions) => {
    if (closed) throw new RemoteConnectionError("the connection was closed");
    const giveBack = await waitForPlace(shortPlaces, SHORT_PLACES);
    try {
      const result = await runSsh(program, throughMaster(remoteCommand(command, runOptions.cwd)), { timeoutMs: runOptions.timeoutMs, signal: runOptions.signal });
      // ssh itself exits with 255 when it could not reach the machine; a command that exits with 255 on its own is taken for that too
      if (result.exitCode === 255 && !result.timedOut && !runOptions.signal?.aborted) {
        throw new RemoteConnectionError(`${goneBecause(result.stderr.trim()).message}. The command may or may not have run. Stop here and tell the user that the connection was lost.`);
      }
      return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut };
    } finally {
      giveBack();
    }
  };

  const stream: RemoteStreamer = async (command, streamOptions) => {
    if (closed) throw new RemoteConnectionError("the connection was closed");
    const giveBack = await waitForPlace(commandPlaces, maxSessions - SHORT_PLACES);
    try {
      const outcome = await streamSsh(program, throughMaster(remoteCommand(command, streamOptions.cwd)), { signal: streamOptions.signal, onData: streamOptions.onData });
      // the command's own code travels in its output; the child itself ends with 255 only when ssh could not do its job
      if (outcome.exitCode === 255 && !streamOptions.signal?.aborted) throw goneBecause(outcome.stderr.trim());
      return outcome;
    } finally {
      giveBack();
    }
  };

  const keepAlive = setInterval(() => void run("true", {}).catch(() => undefined), KEEP_ALIVE_MS);
  keepAlive.unref();

  return {
    run,
    stream,
    socketDirectory: directory,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
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
    "A lost connection is not made again by itself: when a tool says it was lost, stop and tell the user. " +
    "Files are on the remote machine."
  );
}

/** An environment whose tools run on another machine over ssh. Close it (or dispose of the agent) to hang up. */
export async function createSshEnvironment(options: SshOptions & { cwd: string; workDir?: string }) {
  const connection = await connectSsh(options);
  return createRemoteEnvironment({
    cwd: options.cwd,
    run: connection.run,
    stream: connection.stream,
    close: connection.close,
    description: describeSsh(options.host, options.cwd),
    ...(options.workDir !== undefined ? { workDir: options.workDir } : {}),
  });
}
