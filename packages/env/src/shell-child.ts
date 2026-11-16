import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ShellProcess } from "./shell-session.ts";

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
