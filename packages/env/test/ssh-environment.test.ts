// createSshEnvironment: the connection, the remote environment and the words for the model, put together, with a stand-in ssh program.
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createSshEnvironment, RemoteConnectionError } from "../src/index.ts";

const fake = new URL("./fixtures/fake-ssh.mjs", import.meta.url).pathname;
let bin: string;
let dir: string;
let logFile: string;
const opened: Environment[] = [];

beforeAll(async () => {
  await chmod(fake, 0o755);
  bin = await mkdtemp(join(tmpdir(), "sshenv-bin-"));
  await writeFile(join(bin, "setsid"), '#!/bin/bash\nexec python3 -c "import os,sys;os.setsid();os.execvp(sys.argv[1],sys.argv[1:])" "$@"\n');
  await chmod(join(bin, "setsid"), 0o755);
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sshenv-"));
  logFile = join(dir, "calls.jsonl");
  process.env.FAKE_SSH_LOG = logFile;
  process.env.FAKE_SSH_PATH_PREFIX = bin;
  delete process.env.FAKE_SSH_CONNECT_FAIL;
  delete process.env.FAKE_SSH_DROP_ON;
});
afterEach(async () => {
  for (const env of opened.splice(0)) await env.dispose();
  delete process.env.FAKE_SSH_LOG;
  delete process.env.FAKE_SSH_DROP_ON;
  delete process.env.FAKE_SSH_CONNECT_FAIL;
  await rm(dir, { recursive: true, force: true });
});

const make = async (extra: Record<string, unknown> = {}) => {
  const env = await createSshEnvironment({ host: "box", cwd: dir, ssh: fake, ...extra });
  opened.push(env);
  return env;
};
const calls = async () =>
  (await readFile(logFile, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("the ssh environment: what the model is told", () => {
  it("says that the tools run on another machine, which one and where, and that nothing about the connection is guaranteed", async () => {
    const env = await make({ host: "build-server" });
    const text = env.description ?? "";
    expect(text).toContain("build-server");
    expect(text).toContain(dir);
    expect(text).toContain("not the computer that runs you");
    expect(text).toContain("cd and export do not carry over");
    expect(text).toContain("not guaranteed to be repeatable");
    expect(text).toContain("may or may not have run");
    expect(text).toContain("Files are on the remote machine");
  });

  it("is told to look at the state before repeating something that changes it", async () => {
    expect((await make()).description).toContain("before you repeat anything that changes something");
  });
});

describe("the ssh environment: one connection for everything it does", () => {
  it("files, listings and commands together are one login", async () => {
    const env = await make();
    await env.writeFile("a.txt", "hello");
    expect(new TextDecoder().decode(await env.readFile("a.txt"))).toBe("hello");
    expect(await env.list(".")).toContain("a.txt");
    expect((await env.stat("a.txt"))?.size).toBe(5);
    expect((await env.exec("echo hi", {})).output.trim()).toBe("hi");
    expect((await env.spawn("echo there", {}).wait()).output.trim()).toBe("there");
    const all = await calls();
    expect(all.filter((call) => call.kind === "master")).toHaveLength(1);
    expect(all.filter((call) => call.kind === "command").length).toBeGreaterThan(8);
  });

  it("disposing hangs up once, however often, and clears what the session left on the other side", async () => {
    const env = await make();
    await env.spawn("echo one", {}).wait();
    await env.dispose();
    await env.dispose();
    expect((await calls()).filter((call) => call.kind === "exit")).toHaveLength(1);
    expect((await readdir(join(dir, ".sakura", "remote"))).filter((name) => /\.(sh|log|code)$/.test(name))).toEqual([]);
  });

  it("a command that is still running when it is disposed of is stopped", async () => {
    const env = await make();
    env.spawn("sleep 30; touch should-not-exist", {});
    await sleep(400);
    await env.dispose();
    await sleep(500);
    expect(await readdir(dir)).not.toContain("should-not-exist");
  });
});

describe("the ssh environment: when the connection is not there", () => {
  it("creating it fails at once, saying why, instead of failing in the middle of a task", async () => {
    process.env.FAKE_SSH_CONNECT_FAIL = "1";
    const error = await createSshEnvironment({ host: "box", cwd: dir, ssh: fake }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("Connection refused");
  });

  it("a command whose answer is lost is not reported as ended, and says where its output is", async () => {
    const env = await make();
    process.env.FAKE_SSH_DROP_ON = "2"; // the first look at whether the command is done
    const handle = env.spawn("sleep 0.4; echo finished > evidence.txt", {});
    const error = await handle.wait().catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain(handle.outputFile);
    expect(error.message).toContain("may still be running");
  });

  it("the command went on, and the next command through the same environment reads what it left", async () => {
    const env = await make();
    process.env.FAKE_SSH_DROP_ON = "2";
    const handle = env.spawn("sleep 0.4; echo finished > evidence.txt; echo output-of-it", {});
    await handle.wait().catch(() => undefined);
    await sleep(1200);
    expect(new TextDecoder().decode(await env.readFile("evidence.txt"))).toBe("finished\n");
    expect(new TextDecoder().decode(await env.readFile(handle.outputFile))).toContain("output-of-it");
  });

  it("a file operation that cannot get through says so, and the next one works again", async () => {
    const env = await make();
    process.env.FAKE_SSH_DROP_ON = "1";
    await expect(env.writeFile("a.txt", "x")).rejects.toBeInstanceOf(RemoteConnectionError);
    await env.writeFile("a.txt", "x");
    expect(new TextDecoder().decode(await env.readFile("a.txt"))).toBe("x");
  });
});
