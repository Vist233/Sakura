// Where the tools run: this machine (the default), a remote machine over ssh, or a container. The agent and the session file stay here; only the tools go there.
import { createDockerEnvironment, createSshEnvironment } from "./framework.ts";
import type { Environment } from "./framework.ts";
import { ConfigError } from "./config.ts";

/** A way to make the environment of a session. It is called again each time the session is reopened (a change of model or permissions), because closing a session closes its environment. */
export type MakeEnvironment = () => Promise<Environment>;

export interface TargetFlags {
  ssh?: string | undefined;
  docker?: string | undefined;
  /** The directory on the other machine where commands start. */
  cwd?: string | undefined;
}

/**
 * The environment to use for `--ssh HOST` or `--docker CONTAINER`, or undefined for this machine. The directory (`--cwd`) is a path on the other side,
 * so it is required there. `SAKURACODE_SSH` and `SAKURACODE_DOCKER` name another program than `ssh` and `docker` (a hook for tests).
 */
export function targetFromFlags(flags: TargetFlags, env: Record<string, string | undefined>): MakeEnvironment | undefined {
  if (flags.ssh !== undefined && flags.docker !== undefined) throw new ConfigError("--ssh and --docker cannot be used together");
  if (flags.ssh === undefined && flags.docker === undefined) return undefined;
  if (flags.cwd === undefined || !flags.cwd.startsWith("/")) throw new ConfigError("--ssh and --docker need --cwd DIR, an absolute path on the other machine (where commands start)");
  const cwd = flags.cwd;
  if (flags.ssh !== undefined) {
    const host = flags.ssh;
    return () => createSshEnvironment({ host, cwd, ...(env.SAKURACODE_SSH ? { ssh: env.SAKURACODE_SSH } : {}) });
  }
  const container = flags.docker as string;
  return async () => createDockerEnvironment({ container, cwd, ...(env.SAKURACODE_DOCKER ? { docker: env.SAKURACODE_DOCKER } : {}) });
}
