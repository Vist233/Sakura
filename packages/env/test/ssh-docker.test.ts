// The ssh environment against a real sshd: a throwaway container made from an image that is already on this machine (nothing is pulled, nothing else is touched).
// Skipped when docker or the image is not there. The container, its key and its port exist only for this file and are removed at the end.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { connectSsh, createRemoteEnvironment, RemoteConnectionError } from "../src/index.ts";
import type { SshConnection } from "../src/index.ts";

const IMAGE = "lscr.io/linuxserver/openssh-server:latest";
const available = (() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const container = `sakura-env-sshd-${process.pid}`;
let keyDir: string;
let port = 0;
const sshOptions = () => ({
  host: "tester@127.0.0.1",
  port,
  identityFile: join(keyDir, "id"),
  options: { StrictHostKeyChecking: "no", UserKnownHostsFile: "/dev/null", LogLevel: "ERROR" },
  connectTimeoutSec: 5,
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port: chosen } = server.address() as { port: number };
      server.close(() => resolve(chosen));
    });
    server.on("error", reject);
  });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface Opened {
  env: Environment;
  connection: SshConnection;
}
const opened: Opened[] = [];
async function open(): Promise<Opened> {
  const connection = await connectSsh(sshOptions());
  const env = createRemoteEnvironment({ cwd: "/config", run: connection.run, stream: connection.stream, close: connection.close });
  const pair = { env, connection };
  opened.push(pair);
  return pair;
}

async function masterPidsOf(directory: string): Promise<number[]> {
  const sockets = (await readdir(directory)).map((name) => join(directory, name));
  return sockets.flatMap((socket) => {
    const check = spawnSync("ssh", ["-S", socket, "-O", "check", "x"], { encoding: "utf8" });
    const found = /pid=(\d+)/.exec(`${check.stdout}${check.stderr}`);
    return found ? [Number(found[1])] : [];
  });
}
/** Kills the master of a connection, the hard way (nothing is said to the clients). */
async function killMaster(connection: SshConnection): Promise<void> {
  const pids = await masterPidsOf(connection.socketDirectory);
  expect(pids).toHaveLength(1);
  process.kill(pids[0]!, "SIGKILL");
  await sleep(200);
}
const remoteCount = async (env: Environment, pattern: string) => Number((await env.exec(`ps -eo args | grep -F -- '${pattern}' | grep -v grep | wc -l`, {})).output.trim());
async function waitFor(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (!available) return;
  keyDir = await mkdtemp(join(tmpdir(), "sshd-key-"));
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(keyDir, "id")]);
  port = await freePort();
  const publicKey = (await readFile(join(keyDir, "id.pub"), "utf8")).trim();
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-e",
      "PUID=1000",
      "-e",
      "PGID=1000",
      "-e",
      "USER_NAME=tester",
      "-e",
      `PUBLIC_KEY=${publicKey}`,
      "-e",
      "SUDO_ACCESS=false",
      "-e",
      "PASSWORD_ACCESS=false",
      "-p",
      `127.0.0.1:${port}:2222`,
      IMAGE,
    ],
    { stdio: "ignore" },
  );
  await waitFor(
    async () =>
      spawnSync("ssh", [
        "-i",
        join(keyDir, "id"),
        "-p",
        String(port),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ConnectTimeout=2",
        "tester@127.0.0.1",
        "true",
      ]).status === 0,
    "the sshd container",
    60_000,
  );
}, 90_000);

afterEach(async () => {
  for (const { env } of opened.splice(0)) await env.dispose().catch(() => undefined);
});
afterAll(async () => {
  if (!available) return;
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  await rm(keyDir, { recursive: true, force: true });
});

describe.skipIf(!available)("ssh environment against a real sshd", () => {
  it("a command's output keeps the order of stdout and stderr, and its exit code is its own", async () => {
    const { env } = await open();
    const result = await env.spawn("echo a; echo b >&2; echo c; echo d >&2; exit 3", {}).wait();
    expect(result).toEqual({ exitCode: 3, output: "a\nb\nc\nd\n", timedOut: false });
  });

  it("an exit code of 255 is the command's own and not a lost connection", async () => {
    const { env } = await open();
    expect((await env.spawn("exit 255", {}).wait()).exitCode).toBe(255);
  });

  it("output without a final newline, or that looks like the protocol, comes back unchanged", async () => {
    const { env } = await open();
    expect((await env.spawn("printf 'no newline'", {}).wait()).output).toBe("no newline");
    const tricky = "@@x-exit 0\n\n@@y-pid 12\nend";
    expect((await env.spawn(`printf '%s' '${tricky}'`, {}).wait()).output).toBe(tricky);
  });

  it("a large output arrives whole and in order", async () => {
    const { env } = await open();
    const result = await env.spawn("seq 1 400000", {}).wait();
    expect(result.exitCode).toBe(0);
    const numbers = result.output.trimEnd().split("\n").map(Number);
    expect(numbers).toHaveLength(400000);
    expect(numbers.every((value, index) => value === index + 1)).toBe(true);
  }, 60_000);

  it("the output is in the log file on the remote machine as it is produced", async () => {
    const { env } = await open();
    const handle = env.spawn("echo first; sleep 2; echo second", {});
    await waitFor(async () => decode(await env.readFile(handle.outputFile).catch(() => new Uint8Array())).includes("first"), "the first line");
    expect(decode(await env.readFile(handle.outputFile))).not.toContain("second");
    expect((await handle.wait()).output).toBe("first\nsecond\n");
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.finished).toBe(true);
  });

  it("every command starts fresh in the working directory, and cwd can be chosen", async () => {
    const { env } = await open();
    expect((await env.exec("pwd", {})).output.trim()).toBe("/config");
    expect((await env.exec("cd /tmp; export X=1", {})).exitCode).toBe(0);
    expect((await env.exec('pwd; echo "[$X]"', {})).output).toBe("/config\n[]\n");
    expect((await env.exec("pwd", { cwd: "/tmp" })).output.trim()).toBe("/tmp");
  });

  it("many commands in a row and side by side all come back right, over one login", async () => {
    const { env, connection } = await open();
    for (let index = 0; index < 40; index++) expect((await env.exec(`echo ${index}`, {})).output.trim()).toBe(String(index));
    const together = await Promise.all(Array.from({ length: 20 }, (_, index) => env.exec(`sleep 0.2; echo p${index}`, {})));
    expect(together.map((result) => result.output.trim())).toEqual(Array.from({ length: 20 }, (_, index) => `p${index}`));
    expect(await masterPidsOf(connection.socketDirectory)).toHaveLength(1);
  }, 60_000);

  it("a timeout stops the command and its children on the remote machine", async () => {
    const { env } = await open();
    const started = Date.now();
    const result = await env.exec("sleep 41.1 & sleep 41.2 & wait", { timeoutMs: 700 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await remoteCount(env, "sleep 41.")).toBe(0);
  });

  it("an abort stops the command and its children, and wait() ends", async () => {
    const { env } = await open();
    const controller = new AbortController();
    const handle = env.spawn("sleep 42.1 & sleep 42.2 & wait", { signal: controller.signal });
    await waitFor(async () => (await remoteCount(env, "sleep 42.")) === 2, "the children");
    controller.abort();
    expect((await handle.wait()).exitCode).toBeNull();
    expect(await remoteCount(env, "sleep 42.")).toBe(0);
  });

  it("kill() before the command has been seen starting still stops it", async () => {
    const { env } = await open();
    const handle = env.spawn("sleep 43.1", {});
    handle.kill();
    await handle.wait();
    await sleep(1500);
    expect(await remoteCount(env, "sleep 43.1")).toBe(0);
  });

  it("dispose stops what is still running", async () => {
    const { env } = await open();
    const other = await open();
    env.spawn("sleep 44.1", {});
    await waitFor(async () => (await remoteCount(other.env, "sleep 44.1")) === 1, "the command");
    await env.dispose();
    expect(await remoteCount(other.env, "sleep 44.1")).toBe(0);
  });
});

describe.skipIf(!available)("ssh environment against a real sshd: the connection dies", () => {
  it("a command that runs on after the master is killed ends in an error that says to stop, and the command finished anyway", async () => {
    const { env, connection } = await open();
    const handle = env.spawn("sleep 3.3; echo survived > /tmp/f5-survivor; echo output-of-it", {});
    await waitFor(async () => (await remoteCount(env, "sleep 3.3")) >= 1, "the command");
    await killMaster(connection);
    const error = await handle.wait().catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain(handle.outputFile);
    expect(error.message).toContain("Stop here and tell the user");
    expect(error.message).toContain("lost");
    expect(handle.finished).toBe(true);
    // the command was detached from the connection: a new connection finds what it left
    const again = await open();
    // the shell that started the command and the part that copies its log are gone too: nothing of it keeps looping on the remote machine
    const id = handle.outputFile.slice(handle.outputFile.lastIndexOf("/") + 1, -".log".length);
    await waitFor(async () => (await remoteCount(again.env, id)) === 0, "the command's shells to end");
    await waitFor(async () => (await again.env.exec("cat /tmp/f5-survivor", {})).output.includes("survived"), "the survivor file");
    expect(decode(await again.env.readFile(handle.outputFile))).toBe("output-of-it\n");
  }, 40_000);

  it("after the master is gone every operation fails at once, the same way, and nothing reconnects", async () => {
    const { env, connection } = await open();
    await env.exec("true", {});
    await killMaster(connection);
    for (const operation of [
      () => env.exec("echo hi", {}),
      () => env.spawn("echo hi", {}).wait(),
      () => env.readFile("/etc/hostname"),
      () => env.writeFile("/tmp/x", "y"),
      () => env.list("/tmp"),
      () => env.stat("/tmp"),
    ]) {
      const started = Date.now();
      const error = await operation().then(
        () => undefined,
        (caught) => caught,
      );
      expect(error).toBeInstanceOf(RemoteConnectionError);
      expect(Date.now() - started).toBeLessThan(3000);
    }
    const message = (await env.exec("echo hi", {}).catch((caught) => caught)).message as string;
    expect(message).toContain("tester@127.0.0.1");
    expect(message).toContain("Stop here and tell the user");
    // no master came back
    expect(await masterPidsOf(connection.socketDirectory)).toEqual([]);
  }, 40_000);

  it("a master that was never there makes creating the environment fail with the reason", async () => {
    const error = await connectSsh({ ...sshOptions(), port: await freePort() }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("could not connect");
  });
});
