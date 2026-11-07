// One suite, every implementation of Environment. A new implementation must pass all of it.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createLocalEnvironment, createRemoteEnvironment } from "../src/index.ts";
import type { RemoteRunner } from "../src/index.ts";

let bin: string;
beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "contract-bin-"));
  // macOS has no setsid; the remote environment starts background commands with it
  await writeFile(join(bin, "setsid"), '#!/bin/bash\nexec python3 -c "import os,sys;os.setsid();os.execvp(sys.argv[1],sys.argv[1:])" "$@"\n');
  await chmod(join(bin, "setsid"), 0o755);
});
afterAll(async () => rm(bin, { recursive: true, force: true }));

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const implementations: Array<[string, (dir: string) => Environment]> = [
  ["local environment", (dir) => createLocalEnvironment(dir)],
  [
    "remote environment (commands run in a scratch directory)",
    (dir) => {
      const run: RemoteRunner = (command, options) =>
        new Promise((resolve) => {
          const child = spawn("/bin/bash", ["-c", command], { cwd: options.cwd ?? dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
          let output = "";
          let timedOut = false;
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.on("close", (code) => resolve({ exitCode: code, output, timedOut }));
          options.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true }); // what a real runner does with the signal
          if (options.timeoutMs !== undefined)
            setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, options.timeoutMs);
        });
      return createRemoteEnvironment({ cwd: dir, run });
    },
  ],
];

for (const [name, build] of implementations) {
  describe(`Environment contract: ${name}`, () => {
    let dir: string;
    let env: Environment;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "envc-"));
      env = build(dir);
    });
    afterAll(async () => {
      await env.dispose();
      await rm(dir, { recursive: true, force: true });
    });

    it("cwd is the directory it was given and resolve makes relative paths absolute", () => {
      expect(env.cwd).toBe(dir);
      expect(env.resolve("a/b.txt")).toBe(join(dir, "a/b.txt"));
      expect(env.resolve("/abs/x")).toBe("/abs/x");
    });

    it("writes a file (creating folders), reads it back, and reports it with stat", async () => {
      await env.writeFile("deep/er/file.txt", "héllo\nworld");
      expect(decode(await env.readFile("deep/er/file.txt"))).toBe("héllo\nworld");
      expect(await env.stat("deep/er/file.txt")).toMatchObject({ isFile: true, isDirectory: false, size: Buffer.byteLength("héllo\nworld") });
      expect(await env.stat("deep/er")).toMatchObject({ isFile: false, isDirectory: true });
    });

    it("binary data survives a round trip", async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      await env.writeFile("bin.dat", bytes);
      expect(Array.from(await env.readFile("bin.dat"))).toEqual(Array.from(bytes));
    });

    it("stat of a missing path is undefined and reading it fails", async () => {
      expect(await env.stat("nothing-here")).toBeUndefined();
      await expect(env.readFile("nothing-here")).rejects.toThrow();
    });

    it("overwriting replaces the content", async () => {
      await env.writeFile("over.txt", "long long long");
      await env.writeFile("over.txt", "short");
      expect(decode(await env.readFile("over.txt"))).toBe("short");
    });

    it("list returns the names in a directory", async () => {
      await env.writeFile("lst/a.txt", "1");
      await env.writeFile("lst/b.txt", "2");
      expect((await env.list("lst")).sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("exec returns the combined output and the exit code", async () => {
      const ok = await env.exec("echo out; echo err 1>&2", {});
      expect(ok.exitCode).toBe(0);
      expect(ok.output).toContain("out");
      expect(ok.output).toContain("err");
      const bad = await env.exec("exit 7", {});
      expect(bad.exitCode).toBe(7);
      expect(bad.timedOut).toBe(false);
    });

    it("exec runs in the working directory, or in the one given", async () => {
      await env.writeFile("sub/marker.txt", "x");
      expect((await env.exec("pwd", {})).output.trim().endsWith(dir.split("/").pop()!)).toBe(true);
      expect((await env.exec("ls", { cwd: join(dir, "sub") })).output).toContain("marker.txt");
    });

    it("exec stops a command at the time limit and says so", async () => {
      const started = Date.now();
      const result = await env.exec("sleep 5", { timeoutMs: 300 });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("exec stops a command when the signal is aborted", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const started = Date.now();
      const result = await env.exec("sleep 5", { signal: controller.signal });
      expect(result.exitCode === 0).toBe(false);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("spawn returns a handle whose output file fills and whose wait gives the result", async () => {
      const handle = env.spawn("echo started; sleep 0.3; echo finished", {});
      const result = await handle.wait();
      expect(handle.pid).toBeGreaterThan(0); // a remote environment learns the pid a moment after the start
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("started");
      expect(result.output).toContain("finished");
      expect(handle.finished).toBe(true);
      expect(decode(await env.readFile(handle.outputFile))).toContain("finished");
    });

    it("spawn: kill stops the command", async () => {
      const handle = env.spawn("sleep 30", {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      handle.kill();
      const result = await Promise.race([handle.wait(), new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000))]);
      expect(result).not.toBe("hung");
    });
  });
}
