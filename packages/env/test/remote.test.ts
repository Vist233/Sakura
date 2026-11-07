import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createRemoteEnvironment } from "../src/index.ts";
import type { RemoteRunner } from "../src/index.ts";

let dir: string;
let bin: string;
let env: Environment;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// a stand-in for a container: commands run in a scratch directory; `setsid` is not on macOS, so a shim provides it
const runner: RemoteRunner = (command, options) =>
  new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { cwd: options.cwd ?? dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ exitCode: code, output, timedOut: false }));
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "remote-"));
  bin = await mkdtemp(join(tmpdir(), "remote-bin-"));
  await writeFile(join(bin, "setsid"), '#!/bin/bash\nexec python3 -c "import os,sys;os.setsid();os.execvp(sys.argv[1],sys.argv[1:])" "$@"\n');
  await chmod(join(bin, "setsid"), 0o755);
  env = createRemoteEnvironment({ cwd: dir, run: runner });
});
afterAll(async () => {
  await env.dispose();
  await rm(dir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

describe("remote environment: files", () => {
  const texts = ["plain", "with 'single' and \"double\" quotes", "line one\nline two\n", "unicode: 你好 ✓ é", "$HOME `date` $(id) \\ backslash", "", "x".repeat(150_000)];
  for (const [index, text] of texts.entries()) {
    it(`writes and reads back text ${index} (${text.length} characters)`, async () => {
      await env.writeFile(`files/t${index}.txt`, text);
      expect(decode(await env.readFile(`files/t${index}.txt`))).toBe(text);
    });
  }
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`round-trips random bytes (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const bytes = new Uint8Array(rng.int(1, 120_000)).map(() => rng.int(0, 255));
      await env.writeFile(`bin/b${seed}.bin`, bytes);
      expect([...(await env.readFile(`bin/b${seed}.bin`))]).toEqual([...bytes]);
    });
  }
  it("overwrites and creates parent directories", async () => {
    await env.writeFile("deep/er/f.txt", "one");
    await env.writeFile("deep/er/f.txt", "two");
    expect(decode(await env.readFile("deep/er/f.txt"))).toBe("two");
  });
  it("reading a missing file fails with a message", async () => {
    await expect(env.readFile("nope.txt")).rejects.toThrow();
  });
  it("stat tells files, directories and nothing apart", async () => {
    await env.writeFile("s/file.txt", "12345");
    expect(await env.stat("s/file.txt")).toEqual({ isFile: true, isDirectory: false, size: 5 });
    expect(await env.stat("s")).toMatchObject({ isDirectory: true, isFile: false });
    expect(await env.stat("s/missing")).toBeUndefined();
  });
  it("stat copes with awkward names", async () => {
    await env.writeFile("odd/it's here.txt", "x");
    expect((await env.stat("odd/it's here.txt"))?.isFile).toBe(true);
  });
  it("lists a directory, hidden files included, sorted", async () => {
    for (const name of ["c", "a", ".hidden", "b"]) await env.writeFile(`ls/${name}`, "");
    expect(await env.list("ls")).toEqual([".hidden", "a", "b", "c"]);
  });
  it("resolves relative and absolute paths against its working directory", () => {
    expect(env.resolve("a/b.txt")).toBe(`${env.cwd}/a/b.txt`);
    expect(env.resolve("/etc/hosts")).toBe("/etc/hosts");
    expect(env.resolve("a/../b")).toBe(`${env.cwd}/b`);
  });
});

describe("remote environment: commands", () => {
  it("exec returns the output and exit code", async () => {
    const result = await env.exec("echo hi; exit 3", {});
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("hi");
  });
  it("exec uses the given working directory", async () => {
    await env.writeFile("cwdtest/marker", "");
    expect((await env.exec("ls", { cwd: "cwdtest" })).output).toContain("marker");
  });
  it("spawn runs a command and reports its output, exit code and output file", async () => {
    const handle = env.spawn("echo started; echo oops 1>&2; exit 4", {});
    const result = await handle.wait();
    expect(result.exitCode).toBe(4);
    expect(result.output).toContain("started");
    expect(result.output).toContain("oops");
    expect(handle.finished).toBe(true);
    expect(decode(await env.readFile(handle.outputFile))).toContain("started");
  });
  it("spawn runs in the requested directory", async () => {
    await env.writeFile("spawndir/inside.txt", "");
    const result = await env.spawn("ls", { cwd: "spawndir" }).wait();
    expect(result.output).toContain("inside.txt");
  });
  it("spawn handles quotes and shell syntax in commands", async () => {
    const result = await env.spawn(`printf '%s\\n' "it's" 'a "b"' | tr a-z A-Z`, {}).wait();
    expect(result.output).toContain("IT'S");
  });
  it("a long command can be killed and its whole process group goes", async () => {
    const handle = env.spawn("sleep 30", {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(handle.pid).toBeGreaterThan(0);
    expect(alive(handle.pid)).toBe(true);
    handle.kill();
    await handle.wait();
    expect(alive(handle.pid)).toBe(false);
  });
  it("dispose stops commands that are still running", async () => {
    const handle = env.spawn("sleep 30", {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    await env.dispose();
    await handle.wait();
    expect(alive(handle.pid)).toBe(false);
  });
});

describe("remote environment: when the runner misbehaves", () => {
  it("a command that cannot be started says so instead of waiting forever", async () => {
    const broken = createRemoteEnvironment({ cwd: "/work", run: async () => ({ exitCode: 0, output: "no process id here", timedOut: false }) });
    const handle = broken.spawn("echo hi", {});
    expect(await handle.wait()).toEqual({ exitCode: null, output: "the command could not be started", timedOut: false });
    expect(handle.finished).toBe(true);
  });

  it("a helper command that fails is an error carrying its output, or its exit code when it printed nothing", async () => {
    const noisy = createRemoteEnvironment({ cwd: "/work", run: async () => ({ exitCode: 2, output: "disk is read-only\n", timedOut: false }) });
    await expect(noisy.writeFile("a.txt", "x")).rejects.toThrow("disk is read-only");
    const silent = createRemoteEnvironment({ cwd: "/work", run: async () => ({ exitCode: 2, output: "", timedOut: false }) });
    await expect(silent.writeFile("a.txt", "x")).rejects.toThrow("command failed with exit code 2");
  });
});
