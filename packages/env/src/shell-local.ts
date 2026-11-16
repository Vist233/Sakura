import { spawn } from "node:child_process";
import { shellOverChild } from "./shell-child.ts";
import type { ShellTransport } from "./shell-session.ts";

/** Bash on this machine, in a process group of its own so that an interrupt or a stop reaches what the shell started. */
export function localShellTransport(hooks: { started?(pid: number): void; ended?(pid: number): void } = {}): ShellTransport {
  const signalGroup = (pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  };
  return {
    start(cwd) {
      const child = spawn("/bin/bash", [], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const pid = child.pid;
      if (pid !== undefined) hooks.started?.(pid);
      return shellOverChild(child, { kill: () => pid !== undefined && signalGroup(pid, "SIGKILL"), ended: () => pid !== undefined && hooks.ended?.(pid) });
    },
    async interrupt(pid, signal) {
      signalGroup(pid, signal === "INT" ? "SIGINT" : "SIGKILL");
    },
  };
}
