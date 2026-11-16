import { spawn } from "node:child_process";
import type { ExecResult } from "@sakura/kernel";
import { RemoteConnectionError } from "./remote-types.ts";
import { appendTail } from "./tail.ts";

/** Runs a program (ssh, docker) on this machine and collects what it prints. */
export function runProgram(program: string, args: string[], options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined }): Promise<ExecResult & { stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let timedOut = false;
    const keep = (chunk: Buffer, target: "both" | "stderr") => {
      const text = chunk.toString("utf8");
      output = appendTail(output, text);
      if (target === "stderr") stderr = appendTail(stderr, text, 64_000);
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

/** Runs a program (ssh, docker) on this machine and passes on what it prints as it prints it. What the program itself says (its stderr) is kept apart from the command's output. */
export function streamProgram(program: string, args: string[], options: { signal?: AbortSignal | undefined; onData(text: string): void }): Promise<{ exitCode: number | null; stderr: string }> {
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
