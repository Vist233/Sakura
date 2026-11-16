// A shell as a child process: what the transports for this machine, ssh and docker share (the child to shell wrapper), and bash on this machine.
import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { signalChildrenCommand } from "./shell-session.ts";
import type { ShellProcess, ShellTransport } from "./shell-session.ts";

/**
 * A `ShellProcess` made of a child process whose input and output are the shell's (bash itself, `ssh host bash`, `docker exec -i c bash`).
 * `kill` stops the child and whatever it started. `exitInfo` turns how the child ended into what the session is told: the default is the exit code
 * (nothing for a signal); a transport adds an `error` when the end means the way to the shell was lost.
 */
export function shellOverChild(
  child: ChildProcessWithoutNullStreams,
  options: { kill(): void; exitInfo?(code: number | null, stderr: string): { error?: Error; code?: number }; ended?(): void },
): ShellProcess {
  child.stdin.on("error", () => undefined); // a shell that is gone: the end is reported through onExit
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (text: string) => {
    stderr = (stderr + text).slice(-4000);
  });
  return {
    write: (text) => void child.stdin.write(text),
    onData: (listener) => void child.stdout.on("data", listener),
    onExit(listener) {
      let reported = false;
      const report = (info: { error?: Error; code?: number }) => {
        if (reported) return;
        reported = true;
        options.ended?.();
        listener(info);
      };
      child.on("error", (error) => report({ error }));
      child.on("close", (code) => report(options.exitInfo ? options.exitInfo(code, stderr) : code === null ? {} : { code }));
    },
    kill: options.kill,
  };
}

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
      // the shell's own group holds it and what it started; only the children are picked out (with pkill) when the shell is to stay
      if (signal === "CHILDREN") await new Promise<void>((resolve) => execFile("/bin/sh", ["-c", signalChildrenCommand(pid, "CHILDREN")], () => resolve()));
      else signalGroup(pid, signal === "INT" ? "SIGINT" : "SIGKILL");
    },
  };
}
