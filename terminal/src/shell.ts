// Running a shell command for the user (`!cmd`, /diff). Not used by the agent; its own bash tool is separate.
import { spawn } from "node:child_process";

export interface ShellResult {
  output: string;
  /** null when the command was killed. */
  exitCode: number | null;
  timedOut: boolean;
}

export type ShellRunner = (command: string, cwd: string, signal?: AbortSignal) => Promise<ShellResult>;

const MAX_OUTPUT = 200_000;

export const runShell: ShellRunner = (command, cwd, signal) =>
  new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, 120_000);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ output: `${output}${error.message}`, exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: output.length >= MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[output cut]` : output, exitCode: code, timedOut });
    });
  });
