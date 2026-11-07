import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createLocalEnvironment } from "../src/index.ts";

let dir: string;
let env: Environment;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "env-"));
  env = createLocalEnvironment(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("paths", () => {
  for (const [input, expected] of [
    ["a.txt", "a.txt"],
    ["./a.txt", "a.txt"],
    ["sub/../a.txt", "a.txt"],
    ["x/y/z.txt", "x/y/z.txt"],
    ["x//y.txt", "x/y.txt"],
  ] as Array<[string, string]>) {
    it(`resolves relative path ${input}`, () => {
      expect(env.resolve(input)).toBe(join(dir, expected));
    });
  }
  it("keeps absolute paths", () => {
    expect(env.resolve("/etc/hosts")).toBe("/etc/hosts");
  });
  it("normalises absolute paths", () => {
    expect(env.resolve("/tmp/a/../b")).toBe("/tmp/b");
  });
  it("reports its working directory", () => {
    expect(env.cwd).toBe(dir);
  });
});

describe("files", () => {
  for (const seed of range(40)) {
    it(`writes and reads back random content (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const content = Array.from({ length: rng.int(0, 200) }, () => String.fromCharCode(rng.int(32, 0x2fff))).join("");
      const name = `d${rng.int(0, 3)}/e${rng.int(0, 3)}/f${seed}.txt`;
      await env.writeFile(name, content);
      expect(decode(await env.readFile(name))).toBe(content);
      expect((await env.stat(name))?.isFile).toBe(true);
    });
  }

  it("writes bytes", async () => {
    await env.writeFile("b.bin", new Uint8Array([0, 1, 2, 255]));
    expect([...(await env.readFile("b.bin"))]).toEqual([0, 1, 2, 255]);
  });
  it("overwrites existing files", async () => {
    await env.writeFile("a", "one");
    await env.writeFile("a", "two");
    expect(decode(await env.readFile("a"))).toBe("two");
  });
  it("creates missing parent directories", async () => {
    await env.writeFile("deep/er/still/a", "x");
    expect((await env.stat("deep/er"))?.isDirectory).toBe(true);
  });
  it("stat returns undefined for a missing path", async () => {
    expect(await env.stat("nope")).toBeUndefined();
  });
  it("stat reports size", async () => {
    await env.writeFile("s", "12345");
    expect((await env.stat("s"))?.size).toBe(5);
  });
  it("reading a missing file fails", async () => {
    await expect(env.readFile("missing")).rejects.toThrow();
  });
  it("lists a directory in sorted order", async () => {
    for (const name of ["c", "a", "b"]) await writeFile(join(dir, name), "");
    await mkdir(join(dir, "d"));
    expect(await env.list(".")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("exec: output and exit codes", () => {
  for (const seed of range(40, 100)) {
    it(`captures what a command prints (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const word = `w${rng.int(0, 99999)}`;
      const result = await env.exec(`echo ${word}; echo err-${word} 1>&2`, {});
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(word);
      expect(result.output).toContain(`err-${word}`);
      expect(result.timedOut).toBe(false);
    });
  }

  for (const code of [0, 1, 2, 3, 7, 42, 100, 126, 127, 255]) {
    it(`reports exit code ${code}`, async () => {
      expect((await env.exec(`exit ${code}`, {})).exitCode).toBe(code);
    });
  }

  it("runs in the environment's directory by default", async () => {
    expect((await env.exec("pwd", {})).output.trim()).toBe(await realpath(dir));
  });
  it("accepts a different working directory", async () => {
    await mkdir(join(dir, "sub"));
    expect((await env.exec("pwd", { cwd: "sub" })).output.trim()).toBe(await realpath(join(dir, "sub")));
  });
  it("reports a missing command with 127", async () => {
    expect((await env.exec("definitely-not-a-command-xyz", {})).exitCode).toBe(127);
  });
  it("supports pipes and redirects", async () => {
    await env.exec("printf 'b\\na\\n' | sort > out.txt", {});
    expect(decode(await env.readFile("out.txt"))).toBe("a\nb\n");
  });
  it("keeps unicode output intact", async () => {
    expect((await env.exec("echo '你好 ✓'", {})).output.trim()).toBe("你好 ✓");
  });
  it("handles large output", async () => {
    const result = await env.exec("seq 1 100000", {});
    expect(result.output.trim().split("\n")).toHaveLength(100000);
  });
  it("does not read from stdin", async () => {
    const result = await env.exec("cat", { timeoutMs: 3000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });
  it("sees the parent environment variables", async () => {
    process.env.ENV_TEST_VALUE = "visible";
    expect((await env.exec("echo $ENV_TEST_VALUE", {})).output.trim()).toBe("visible");
    delete process.env.ENV_TEST_VALUE;
  });
});

describe("exec: timeouts and cancellation", () => {
  for (const variant of range(10, 200)) {
    it(`a timeout stops the command and its children (variant ${variant})`, async () => {
      const started = Date.now();
      const marker = join(dir, `marker${variant}`);
      const result = await env.exec(`(sleep 30; touch ${marker}) & sleep 30`, { timeoutMs: 100 + variant * 10 });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      await new Promise((done) => setTimeout(done, 100));
      expect(await env.stat(marker)).toBeUndefined();
    });
  }

  it("an abort signal stops the command", async () => {
    const controller = new AbortController();
    const pending = env.exec("sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
  });
  it("an already aborted signal stops it right away", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await env.exec("sleep 30", { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it("a command that finishes before its timeout is not marked as timed out", async () => {
    const result = await env.exec("echo quick", { timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
  });
  it("keeps the output printed before a timeout", async () => {
    const result = await env.exec("echo before; sleep 30", { timeoutMs: 300 });
    expect(result.output).toContain("before");
  });
  it("does not wait for a background process that keeps the output open", async () => {
    const started = Date.now();
    const result = await env.exec("sleep 5 & echo started", {});
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.output).toContain("started");
    expect(result.exitCode).toBe(0);
  });
});

async function realpath(path: string): Promise<string> {
  const { realpath: real } = await import("node:fs/promises");
  return real(path);
}
void readFile;
