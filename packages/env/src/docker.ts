import { spawn } from "node:child_process";
import type { Environment } from "@sakura/kernel";
import { runProgram, streamProgram } from "./process-run.ts";
import { createRemoteEnvironment, RemoteConnectionError } from "./remote.ts";
import type { RemoteRunner } from "./remote.ts";
import type { RemoteStreamer } from "./remote-stream.ts";
import { shellOverChild } from "./shell-child.ts";
import { signalChildrenCommand } from "./shell-session.ts";
import type { ShellProcess, ShellTransport } from "./shell-session.ts";

export interface DockerOptions {
  /** A running container (name or id). */
  container: string;
  /** The directory in the container where commands start. */
  cwd: string;
  /** The docker program (default "docker"). */
  docker?: string;
  /** Where the scripts and logs of background commands are kept in the container. */
  workDir?: string;
}

/** What the model is told about where its tools run, in a container. */
export function describeDocker(container: string, cwd: string): string {
  return (
    `a container (${container}), not the computer that runs you. Commands run in one shell that stays (it starts in ${cwd}): cd, export, source and functions carry over to the next command. ` +
    "A command that runs too long is interrupted and what it printed so far is returned; a shell that is lost is replaced and its state is gone. Background commands run apart from it. " +
    "Files are in the container. If a tool says the container could not be reached, it may have stopped: stop and tell the user."
  );
}

const DOCKER_FAILED = 125; // docker's own code for "the daemon could not do it", as opposed to the command's code

/** An environment whose tools run in a container, through `docker exec`. Dispose of it to stop the shell and the commands (the container is left as it is). */
export function createDockerEnvironment(options: DockerOptions): Environment {
  const program = options.docker ?? "docker";
  const lost = (detail: string) => new RemoteConnectionError(`the container ${options.container} could not be reached: ${detail || "docker exec failed"}. The command may or may not have run.`);
  const execArgs = (flags: string[], cwd: string | undefined, command: string[]) => ["exec", ...flags, ...(cwd !== undefined ? ["-w", cwd] : []), options.container, ...command];

  const run: RemoteRunner = async (command, runOptions) => {
    const result = await runProgram(program, execArgs([], runOptions.cwd, ["bash", "-c", command]), { timeoutMs: runOptions.timeoutMs, signal: runOptions.signal });
    if (result.exitCode === DOCKER_FAILED && !result.timedOut && !runOptions.signal?.aborted) throw lost(result.stderr.trim());
    return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut };
  };
  const stream: RemoteStreamer = async (command, streamOptions) => {
    const outcome = await streamProgram(program, execArgs([], streamOptions.cwd, ["bash", "-c", command]), { signal: streamOptions.signal, onData: streamOptions.onData });
    if (outcome.exitCode === DOCKER_FAILED && !streamOptions.signal?.aborted) throw lost(outcome.stderr.trim());
    return outcome;
  };
  const shell: ShellTransport = {
    start(cwd): ShellProcess {
      const child = spawn(program, execArgs(["-i"], cwd, ["bash"]), { stdio: ["pipe", "pipe", "pipe"] });
      return shellOverChild(child, {
        kill: () => void child.kill("SIGKILL"),
        exitInfo: (code, stderr) => (code === DOCKER_FAILED ? { error: lost(stderr.trim()) } : code === null ? {} : { code }),
      });
    },
    async interrupt(pid, signal) {
      await run(signalChildrenCommand(pid, signal), {});
    },
  };

  return createRemoteEnvironment({
    cwd: options.cwd,
    run,
    stream,
    shell,
    description: describeDocker(options.container, options.cwd),
    ...(options.workDir !== undefined ? { workDir: options.workDir } : {}),
  });
}
