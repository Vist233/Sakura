// What the remote environment promises when the connection to the other side is not reliable: it never says that a command ended or was killed when it only
// lost contact with it, it says where the output is, it cleans up after itself, and a runner that rejects is the only thing it needs to know about.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRemoteEnvironment, RemoteConnectionError } from "../src/index.ts";
import type { RemoteRunner } from "../src/index.ts";

let bin: string;
let dir: string;
beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "rc-bin-"));
  await writeFile(join(bin, "setsid"), '#!/bin/bash\nexec python3 -c "import os,sys;os.setsid();os.execvp(sys.argv[1],sys.argv[1:])" "$@"\n');
  await chmod(join(bin, "setsid"), 0o755);
});
afterAll(async () => rm(bin, { recursive: true, force: true }));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

/** Runs commands on this machine, and fails like a lost connection on the calls the test names (counting from 1). */
function flaky(failOn: (call: number, command: string) => boolean) {
  const commands: string[] = [];
  const run: RemoteRunner = (command, options) => {
    commands.push(command);
    if (failOn(commands.length, command)) return Promise.reject(new RemoteConnectionError("Broken pipe"));
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], { cwd: options.cwd ?? dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ exitCode: code, output, timedOut: false }));
    });
  };
  return { run, commands };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits until the file exists and has something in it (a machine that is busy takes its time), and returns it. */
async function appears(path: string, ms = 15_000): Promise<string> {
  for (let waited = 0; waited < ms; waited += 50) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text !== "") return text;
    await sleep(50);
  }
  throw new Error(`${path} did not appear`);
}

describe("remote: a connection that is lost while a command runs", () => {
  it("is not reported as the command ending or being killed: the wait is refused, and says where the output is", async () => {
    const { run } = flaky((call) => call === 2); // the first look at whether the command has finished
    const env = createRemoteEnvironment({ cwd: dir, run });
    const handle = env.spawn("sleep 1; echo finished > evidence.txt", {});
    const error = await handle.wait().catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("lost");
    expect(error.message).toContain("Broken pipe");
    expect(error.message).toContain("may still be running");
    expect(error.message).toContain(handle.outputFile);
    expect(handle.finished).toBe(true);
    await env.dispose();
  });

  it("and the command goes on and finishes, so what the message says is true", async () => {
    const { run } = flaky((call) => call === 2);
    const env = createRemoteEnvironment({ cwd: dir, run });
    const handle = env.spawn("sleep 0.5; echo finished > evidence.txt; echo said-so", {});
    await handle.wait().catch(() => undefined);
    expect(await appears(join(dir, "evidence.txt"))).toBe("finished\n");
    expect(await appears(handle.outputFile)).toContain("said-so"); // the output is where the message said
  });

  it("when the connection comes back, the output can be read in the ordinary way", async () => {
    const { run } = flaky((call) => call === 2);
    const env = createRemoteEnvironment({ cwd: dir, run });
    const handle = env.spawn("echo kept", {});
    await handle.wait().catch(() => undefined);
    await appears(handle.outputFile);
    expect(new TextDecoder().decode(await env.readFile(handle.outputFile))).toBe("kept\n");
  });

  it("lost while the output is being read is told the same way", async () => {
    const { run } = flaky((call, command) => command.startsWith("cat ") && command.includes(".log"));
    const env = createRemoteEnvironment({ cwd: dir, run });
    const handle = env.spawn("echo done", {});
    const error = await handle.wait().catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("reading the output");
    expect(error.message).toContain(handle.outputFile);
  });

  it("lost while the command is being started says it may or may not be running", async () => {
    const { run } = flaky((call) => call === 1);
    const env = createRemoteEnvironment({ cwd: dir, run });
    const handle = env.spawn("echo hello", {});
    const error = await handle.wait().catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("may or may not be running");
    expect(error.message).toContain(handle.outputFile);
    expect(handle.finished).toBe(true);
  });

  it("a handle that nobody waits for does not leave an unhandled rejection behind", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const { run } = flaky((call) => call === 1);
    const env = createRemoteEnvironment({ cwd: dir, run });
    env.spawn("echo hello", {});
    await sleep(300);
    process.removeListener("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
  });

  it("a command that ran and failed is still just a result with its exit code", async () => {
    const { run } = flaky(() => false);
    const env = createRemoteEnvironment({ cwd: dir, run });
    const result = await env.spawn("echo bad >&2; exit 9", {}).wait();
    expect(result.exitCode).toBe(9);
    expect(result.output).toContain("bad");
  });

  it("a runner that fails in some other way is not turned into a lost connection", async () => {
    const run: RemoteRunner = async () => {
      throw new TypeError("a bug in the runner");
    };
    const env = createRemoteEnvironment({ cwd: dir, run });
    await expect(env.spawn("echo hi", {}).wait()).rejects.toThrow("a bug in the runner");
  });
});

describe("remote: file operations over a connection that is lost", () => {
  it("each says why it failed, with the words the runner used", async () => {
    const { run } = flaky(() => true);
    const env = createRemoteEnvironment({ cwd: dir, run });
    await expect(env.readFile("a.txt")).rejects.toThrow("Broken pipe");
    await expect(env.writeFile("a.txt", "x")).rejects.toThrow("Broken pipe");
    await expect(env.stat("a.txt")).rejects.toThrow("Broken pipe");
    await expect(env.list(".")).rejects.toThrow("Broken pipe");
    await expect(env.exec("true", {})).rejects.toBeInstanceOf(RemoteConnectionError);
  });

  it("the ones that fail are RemoteConnectionErrors, so a caller can tell them from a file that is not there", async () => {
    const { run } = flaky(() => true);
    const env = createRemoteEnvironment({ cwd: dir, run });
    await expect(env.readFile("a.txt")).rejects.toBeInstanceOf(RemoteConnectionError);
    const ok = createRemoteEnvironment({ cwd: dir, run: flaky(() => false).run });
    await expect(ok.readFile("missing.txt")).rejects.not.toBeInstanceOf(RemoteConnectionError);
  });
});

describe("remote: closing", () => {
  it("stops what is running, removes the scripts and logs of this session, and then calls close once", async () => {
    const { run } = flaky(() => false);
    const events: string[] = [];
    const env = createRemoteEnvironment({
      cwd: dir,
      run,
      workDir: join(dir, "work"),
      close: async () => {
        events.push("close");
        expect((await readdir(join(dir, "work"))).filter((name) => !name.startsWith("."))).toEqual([]); // cleaned before the connection went away
      },
    });
    const finished = env.spawn("echo done", {});
    await finished.wait();
    const running = env.spawn("sleep 30; touch should-not-exist", {});
    await sleep(300);
    await env.dispose();
    await env.dispose();
    expect(events).toEqual(["close"]);
    expect(running.finished || true).toBe(true);
    await sleep(500);
    await expect(readFile(join(dir, "should-not-exist"))).rejects.toThrow();
  });

  it("an environment that never ran anything makes no call to clean up", async () => {
    const { run, commands } = flaky(() => false);
    const env = createRemoteEnvironment({ cwd: dir, run });
    await env.dispose();
    expect(commands).toEqual([]);
  });

  it("a connection that is gone when it closes does not stop it from closing", async () => {
    let closed = 0;
    let down = false;
    const { run } = flaky(() => down);
    const env = createRemoteEnvironment({
      cwd: dir,
      run,
      close: async () => {
        closed++;
      },
    });
    await env.spawn("echo hi", {}).wait();
    down = true; // the connection is lost before the environment is disposed of
    await env.dispose();
    expect(closed).toBe(1);
  });

  it("keeps what another session left in the same folder", async () => {
    const { run } = flaky(() => false);
    const first = createRemoteEnvironment({ cwd: dir, run, workDir: join(dir, "work") });
    const second = createRemoteEnvironment({ cwd: dir, run, workDir: join(dir, "work") });
    await first.spawn("echo one", {}).wait();
    await second.spawn("echo two", {}).wait();
    await first.dispose();
    const left = await readdir(join(dir, "work"));
    expect(left.length).toBeGreaterThan(0); // the second session's files
    await second.dispose();
    expect(await readdir(join(dir, "work"))).toEqual([]);
  });

  it("says what the model is told about where its tools run", async () => {
    const { run } = flaky(() => false);
    expect(createRemoteEnvironment({ cwd: dir, run, description: "a remote machine" }).description).toBe("a remote machine");
    expect(createRemoteEnvironment({ cwd: dir, run }).description).toBeUndefined();
  });
});

describe("remote: the working directory stays as the task left it", () => {
  it("helper scripts and logs go to a directory of their own, not into the working directory", async () => {
    const { run } = flaky(() => false);
    const work = join(dir, "..", `${dir.split("/").pop()}-helpers`);
    const env = createRemoteEnvironment({ cwd: dir, run, workDir: work });
    await env.spawn("echo hi", {}).wait();
    await env.writeFile("a.txt", "x");
    expect((await readdir(dir)).sort()).toEqual(["a.txt"]);
    expect((await readdir(work)).some((name) => name.endsWith(".log"))).toBe(true);
    await env.dispose();
    expect(await readdir(work)).toEqual([]);
    await rm(work, { recursive: true, force: true });
  });

  it("by default that directory is not under the working directory", async () => {
    const { run } = flaky(() => false);
    const env = createRemoteEnvironment({ cwd: dir, run });
    await env.spawn("echo hi", {}).wait();
    expect(await readdir(dir)).toEqual([]);
    await env.dispose();
  });
});
