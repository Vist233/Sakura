import type { ExecResult } from "@sakura/kernel";

/**
 * Thrown by a runner when it could not reach the other side, so nothing is known about whether the command ran. A command that did run and failed
 * is not this: it is a result with its own exit code. Whoever writes a runner translates its transport's failures (ssh exits with 255, for example) into this.
 */
export class RemoteConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteConnectionError";
  }
}

/**
 * The one thing a remote environment needs: a way to run a shell command somewhere else and get its output back.
 * It resolves with the result of a command that ran, whatever its exit code, and rejects with a RemoteConnectionError when it could not reach the other side.
 */
export type RemoteRunner = (command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;
