// The ssh connection, checked with a stand-in ssh program (fixtures/fake-ssh.mjs) that logs every call and runs the remote command on this machine.
// The promises: it logs in once and every command reuses that connection; a command comes back exactly as it ran; a connection that cannot be reached
// is reported as such and never as a result; closing hangs up once and leaves nothing behind.
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectSsh, RemoteConnectionError } from "../src/index.ts";

const fake = new URL("./fixtures/fake-ssh.mjs", import.meta.url).pathname;
let dir: string;
let logFile: string;
const open: Array<{ close(): Promise<void> }> = [];

beforeAll(async () => {
  await chmod(fake, 0o755);
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ssh-test-"));
  logFile = join(dir, "calls.jsonl");
  process.env.FAKE_SSH_LOG = logFile;
  delete process.env.FAKE_SSH_CONNECT_FAIL;
  delete process.env.FAKE_SSH_DROP_ON;
});
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.close();
  delete process.env.FAKE_SSH_LOG;
  delete process.env.FAKE_SSH_CONNECT_FAIL;
  delete process.env.FAKE_SSH_DROP_ON;
  await rm(dir, { recursive: true, force: true });
});

const connect = async (extra: Partial<Parameters<typeof connectSsh>[0]> = {}) => {
  const connection = await connectSsh({ host: "box", ssh: fake, ...extra });
  open.push(connection);
  return connection;
};
const calls = async () =>
  (await readFile(logFile, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; number?: number; control?: string; command?: string; host: string; argv: string[] });
const kinds = async () => (await calls()).map((call) => call.kind);
const controlDirectories = async () => (await readdir("/tmp")).filter((name) => name.startsWith("sk-ssh-"));

describe("ssh: one connection for every command", () => {
  it("logs in once, and ten commands later it is still one login", async () => {
    const connection = await connect();
    for (let index = 0; index < 10; index++) await connection.run(`echo ${index}`, { cwd: dir });
    const all = await calls();
    expect(all.filter((call) => call.kind === "master")).toHaveLength(1);
    expect(all.filter((call) => call.kind === "command")).toHaveLength(10);
  });

  it("every command goes through the socket of that one connection", async () => {
    const connection = await connect();
    await connection.run("true", { cwd: dir });
    await connection.run("true", { cwd: dir });
    const controls = new Set((await calls()).map((call) => call.control));
    expect(controls.size).toBe(1);
  });

  it("the socket is in a private folder under /tmp with a name short enough for a socket", async () => {
    const connection = await connect();
    const control = (await calls())[0]!.control!;
    expect(control.startsWith("/tmp/sk-ssh-")).toBe(true);
    expect(control.endsWith("/%C")).toBe(true);
    const folder = control.slice(0, -3);
    expect(((await stat(folder)).mode & 0o777).toString(8)).toBe("700");
    expect(folder.length + 1 + 40).toBeLessThan(104); // %C becomes 40 characters
    await connection.close();
  });

  it("sixty commands at the same time all come back right, over the one connection", async () => {
    const connection = await connect();
    const outputs = await Promise.all(Array.from({ length: 60 }, (_, index) => connection.run(`echo n${index}`, { cwd: dir })));
    expect(outputs.map((result) => result.output.trim())).toEqual(Array.from({ length: 60 }, (_, index) => `n${index}`));
    expect((await kinds()).filter((kind) => kind === "master")).toHaveLength(1);
  });

  it("a connection that dropped is made again by the next command, without being asked", async () => {
    const connection = await connect();
    await connection.run("true", { cwd: dir });
    process.env.FAKE_SSH_DROP_ON = "2";
    await expect(connection.run("true", { cwd: dir })).rejects.toBeInstanceOf(RemoteConnectionError);
    const after = await connection.run("echo back", { cwd: dir });
    expect(after.output.trim()).toBe("back");
  });
});

describe("ssh: what is asked of ssh", () => {
  it("never asks for a password, and keeps the connection alive", async () => {
    const connection = await connect();
    await connection.run("true", { cwd: dir });
    for (const call of await calls()) {
      expect(call.argv).toContain("BatchMode=yes");
      expect(call.argv).toContain("ServerAliveInterval=15");
    }
    expect(connection).toBeDefined();
  });

  it("waits 15 seconds for a connection unless told otherwise", async () => {
    await connect();
    expect((await calls())[0]!.argv).toContain("ConnectTimeout=15");
    await connect({ connectTimeoutSec: 3 });
    expect((await calls()).at(-1)!.argv).toContain("ConnectTimeout=3");
  });

  it("passes the port, the key and any other option on", async () => {
    await connect({ port: 2222, identityFile: "/keys/id", options: { StrictHostKeyChecking: "no", ProxyJump: "jump" } });
    const argv = (await calls())[0]!.argv;
    expect(argv.slice(argv.indexOf("-p"), argv.indexOf("-p") + 2)).toEqual(["-p", "2222"]);
    expect(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2)).toEqual(["-i", "/keys/id"]);
    expect(argv).toContain("StrictHostKeyChecking=no");
    expect(argv).toContain("ProxyJump=jump");
  });

  it("leaves everything else, the host keys above all, to the user's ssh configuration", async () => {
    await connect();
    const argv = (await calls())[0]!.argv.join(" ");
    expect(argv).not.toContain("StrictHostKeyChecking");
    expect(argv).not.toContain("UserKnownHostsFile");
    expect(argv).not.toContain("ForwardAgent");
  });

  it("names the host as given", async () => {
    await connect({ host: "me@example.org" });
    expect((await calls())[0]!.host).toBe("me@example.org");
  });
});

describe("ssh: a command comes back as it ran", () => {
  it("in the folder it was asked to run in", async () => {
    const connection = await connect();
    const result = await connection.run("pwd", { cwd: dir });
    expect(result.output.trim()).toBe(dir);
  });

  for (const code of [0, 1, 2, 7, 127]) {
    it(`with its own exit code (${code})`, async () => {
      const connection = await connect();
      expect((await connection.run(`exit ${code}`, { cwd: dir })).exitCode).toBe(code);
    });
  }

  it("with what it wrote on both outputs", async () => {
    const connection = await connect();
    const result = await connection.run("echo out; echo err 1>&2", { cwd: dir });
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("with large output whole", async () => {
    const connection = await connect();
    const result = await connection.run("head -c 1500000 /dev/zero | tr '\\0' 'x'", { cwd: dir });
    expect(result.output).toHaveLength(1_500_000);
  });

  it("with no output at all", async () => {
    const connection = await connect();
    expect((await connection.run("true", { cwd: dir })).output).toBe("");
  });

  const awkward = [
    "echo 'single quotes'",
    'echo "double quotes"',
    "echo $HOME",
    "echo `echo backticks`",
    "echo 'it'\\''s'",
    "printf 'a\\nb\\n'",
    "echo ünïcödé 日本語",
    "echo a; echo b && echo c || echo d",
    "echo * | head -c 20",
    "echo '$(echo not run)'",
    "cat <<'EOF'\nline one\nline two\nEOF",
  ];
  for (const command of awkward) {
    it(`exactly as a shell here would run it: ${JSON.stringify(command).slice(0, 50)}`, async () => {
      const connection = await connect();
      const viaSsh = await connection.run(command, { cwd: dir });
      const direct = await new Promise<string>((resolve) => {
        import("node:child_process").then(({ execFile }) => execFile("bash", ["-c", command], { cwd: dir }, (_error, stdout, stderr) => resolve(stdout + stderr)));
      });
      expect(viaSsh.output).toBe(direct);
    });
  }

  it("a folder name with spaces and quotes", async () => {
    const odd = join(dir, "it's a folder");
    await writeFile(join(dir, "marker"), "x");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(odd);
    const connection = await connect();
    expect((await connection.run("pwd", { cwd: odd })).output.trim()).toBe(odd);
  });

  it("stops waiting after the time given, and says it timed out", async () => {
    const connection = await connect();
    const started = Date.now();
    const result = await connection.run("sleep 5", { cwd: dir, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops when the signal says so", async () => {
    const connection = await connect();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await connection.run("sleep 5", { cwd: dir, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a signal that was already given stops it at once, and it is not mistaken for a lost connection", async () => {
    const connection = await connect();
    const controller = new AbortController();
    controller.abort();
    const result = await connection.run("sleep 5", { cwd: dir, signal: controller.signal });
    expect(result.exitCode).not.toBe(0);
  });
});

describe("ssh: a connection that cannot be reached is not a result", () => {
  it("connecting says what went wrong, with ssh's own words, and leaves nothing behind", async () => {
    process.env.FAKE_SSH_CONNECT_FAIL = "1";
    const before = await controlDirectories();
    const error = await connectSsh({ host: "box", ssh: fake }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("could not connect to box");
    expect(error.message).toContain("Connection refused");
    expect(await controlDirectories()).toEqual(before);
  });

  it("an ssh program that is not there is the same kind of failure", async () => {
    const error = await connectSsh({ host: "box", ssh: "/no/such/ssh" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("could not run /no/such/ssh");
  });

  it("a command that cannot get through rejects with ssh's own words", async () => {
    const connection = await connect();
    process.env.FAKE_SSH_DROP_ON = "1";
    const error = await connection.run("echo never", { cwd: dir }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteConnectionError);
    expect(error.message).toContain("Broken pipe");
  });

  it("a command that fails on its own is a result, with its exit code and what it wrote", async () => {
    const connection = await connect();
    const result = await connection.run("echo complaint 1>&2; exit 4", { cwd: dir });
    expect(result).toMatchObject({ exitCode: 4, timedOut: false });
    expect(result.output).toContain("complaint");
  });

  it("only that command is lost: the ones before and after are not touched", async () => {
    const connection = await connect();
    process.env.FAKE_SSH_DROP_ON = "2";
    const outcomes = await Promise.allSettled([connection.run("echo a", { cwd: dir }), connection.run("echo b", { cwd: dir }), connection.run("echo c", { cwd: dir })]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
  });
});

describe("ssh: closing", () => {
  it("hangs up once, however often it is asked, and removes the folder it made", async () => {
    const connection = await connect();
    const folder = (await calls())[0]!.control!.slice(0, -3);
    await connection.close();
    await connection.close();
    expect((await kinds()).filter((kind) => kind === "exit")).toHaveLength(1);
    await expect(stat(folder)).rejects.toThrow();
  });

  it("nothing can be run afterwards, and the refusal is a lost connection", async () => {
    const connection = await connect();
    await connection.close();
    await expect(connection.run("true", { cwd: dir })).rejects.toBeInstanceOf(RemoteConnectionError);
  });

  it("closing a connection that was never used still hangs up", async () => {
    const connection = await connect();
    await connection.close();
    expect(await kinds()).toEqual(["master", "exit"]);
  });
});
