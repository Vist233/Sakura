// The error paths of the local environment: a command that cannot start, a signal that is already set, a path that is not a directory.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEnvironment } from "../src/index.ts";
import type { Environment } from "@sakura/kernel";

let dir: string;
let env: Environment;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "local-gaps-"));
  env = createLocalEnvironment(dir);
});
afterEach(async () => {
  await env.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe("local environment: failures", () => {
  it("a command whose directory does not exist ends with no exit code and says why", async () => {
    const result = await env.exec("echo hi", { cwd: "missing-directory" });
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("ENOENT");
  });

  it("a signal that is already aborted stops the command at once", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await env.exec("sleep 20", { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).not.toBe(0);
  });

  it("stopping a command that has already finished does nothing and does not throw", async () => {
    const handle = env.spawn("true", {});
    await handle.wait();
    expect(handle.finished).toBe(true);
    expect(() => handle.kill()).not.toThrow();
  });

  it("asking about a path below a file is an error, not 'does not exist'", async () => {
    await writeFile(join(dir, "plain.txt"), "x");
    await expect(env.stat("plain.txt/inside")).rejects.toThrow(/ENOTDIR/);
  });

  it("a path that does not exist is reported as undefined", async () => {
    expect(await env.stat("nothing-here")).toBeUndefined();
  });

  it("listing a directory that does not exist is an error", async () => {
    await expect(env.list("nothing-here")).rejects.toThrow(/ENOENT/);
  });

  it("a timeout stops the command and says so", async () => {
    const result = await env.exec("sleep 20", { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
