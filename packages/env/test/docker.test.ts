// createDockerEnvironment with a stand-in docker program that runs the command on this machine, and, when docker and a running container are there, with the real thing.
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createDockerEnvironment, RemoteConnectionError } from "../src/index.ts";

const fake = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
let dir: string;
const opened: Environment[] = [];

beforeAll(() => chmod(fake, 0o755));
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "docker-")));
  delete process.env.FAKE_DOCKER_DOWN;
});
afterEach(async () => {
  for (const env of opened.splice(0)) await env.dispose();
  delete process.env.FAKE_DOCKER_DOWN;
  await rm(dir, { recursive: true, force: true });
});
const make = (extra: Record<string, unknown> = {}) => {
  const env = createDockerEnvironment({ container: "c1", cwd: dir, docker: fake, workDir: join(dir, "work"), ...extra });
  opened.push(env);
  return env;
};

describe("docker environment (stand-in docker)", () => {
  it("says it is a container and that the shell stays", () => {
    expect(make().description).toContain("a container (c1)");
    expect(make().description).toContain("carry over");
  });

  it("commands share one shell", async () => {
    const env = make();
    await env.exec("mkdir sub && cd sub && export A=1", {});
    expect((await env.exec("echo $A; basename $PWD", {})).output).toBe("1\nsub\n");
  });

  it("a command that takes too long is interrupted and the shell keeps its state", async () => {
    const env = make();
    await env.exec("export KEPT=yes", {});
    const result = await env.exec("echo go; sleep 30", { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("go\n");
    expect((await env.exec("echo $KEPT", {})).output).toBe("yes\n");
  });

  it("files are read and written", async () => {
    const env = make();
    await env.writeFile(join(dir, "a.txt"), "hello");
    expect(new TextDecoder().decode(await env.readFile(join(dir, "a.txt")))).toBe("hello");
  });

  it("a container that is not running is a lost connection, not a result", async () => {
    process.env.FAKE_DOCKER_DOWN = "1";
    const env = make();
    await expect(env.exec("echo hi", {})).rejects.toBeInstanceOf(RemoteConnectionError);
    await expect(env.exec("echo hi", {})).rejects.toThrow(/container c1 could not be reached/);
  });
});

// the real docker, with a throwaway container made from an image that is already here
const image = (() => {
  try {
    return execFileSync("docker", ["image", "inspect", "-f", "{{.Id}}", "redis:7.4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
})();
describe.skipIf(!image)("docker environment (real docker)", () => {
  const name = `sakura-env-docker-${process.pid}`;
  beforeAll(() => void execFileSync("docker", ["run", "-d", "--rm", "--name", name, "redis:7.4", "sleep", "300"], { stdio: "ignore" }));
  afterAll(() => void execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }));

  it("one shell, state that carries over, an interrupt, and files", async () => {
    const env = createDockerEnvironment({ container: name, cwd: "/tmp" });
    try {
      await env.exec("mkdir -p t && cd t && export X=7", {});
      expect((await env.exec("echo $X; pwd", {})).output).toBe("7\n/tmp/t\n");
      const slow = await env.exec("echo a; sleep 30", { timeoutMs: 800 });
      expect(slow.timedOut).toBe(true);
      expect(slow.output).toContain("a\n");
      expect((await env.exec("echo $X", {})).output).toBe("7\n");
      const background = env.spawn("sleep 1; echo in the background", {});
      expect((await env.exec("echo front", {})).output).toBe("front\n");
      expect((await background.wait()).output).toContain("in the background");
      await env.writeFile("/tmp/t/f.txt", "in the container");
      expect(new TextDecoder().decode(await env.readFile("/tmp/t/f.txt"))).toBe("in the container");
    } finally {
      await env.dispose();
    }
  }, 60_000);
});
