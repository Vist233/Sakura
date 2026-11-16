// Where the tools run: the flags, and the whole command line against a stand-in docker program that runs the command on this machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigError } from "../src/config.ts";
import { targetFromFlags } from "../src/target.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";

const binary = new URL("../bin/sakuracode.mjs", import.meta.url).pathname;
const fakeDocker = new URL("../../packages/env/test/fixtures/fake-docker.mjs", import.meta.url).pathname;

describe("targetFromFlags", () => {
  it("is undefined for this machine", () => {
    assert.equal(targetFromFlags({}, {}), undefined);
    assert.equal(targetFromFlags({ cwd: "relative" }, {}), undefined);
  });
  it("needs an absolute --cwd on the other side", () => {
    assert.throws(() => targetFromFlags({ docker: "c" }, {}), ConfigError);
    assert.throws(() => targetFromFlags({ ssh: "box", cwd: "app" }, {}), /absolute path on the other machine/);
  });
  it("refuses both targets at once", () => {
    assert.throws(() => targetFromFlags({ ssh: "box", docker: "c", cwd: "/app" }, {}), /cannot be used together/);
  });
  it("gives a function that makes an environment each time it is called", async () => {
    const make = targetFromFlags({ docker: "c", cwd: "/tmp" }, { SAKURACODE_DOCKER: fakeDocker });
    assert.ok(make);
    const first = await make();
    const second = await make();
    assert.notEqual(first, second);
    await first.dispose();
    await second.dispose();
  });
});

describe("sakuracode exec --docker", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await chmod(fakeDocker, 0o755);
  });
  afterEach(() => sandbox.cleanup());

  it("runs the tools in the container: the shell stays, and the files are there", async () => {
    const work = join(sandbox.directory, "container-root");
    await mkdir(work);
    const script = join(sandbox.directory, "script.json");
    await writeFile(
      script,
      JSON.stringify([
        { toolCalls: [{ name: "bash", id: "a", args: { command: "mkdir sub && cd sub && export MARK=kept && echo hi > hello.txt" } }] },
        { toolCalls: [{ name: "bash", id: "b", args: { command: "echo $MARK in $(basename $PWD): $(cat hello.txt)" } }] },
        { text: "all done" },
      ]),
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", binary, "exec", "--yolo", "--json", "--docker", "box", "--cwd", work, "go"], {
        cwd: sandbox.directory,
        env: { PATH: process.env.PATH ?? "", HOME: sandbox.directory, SAKURA_HOME: join(sandbox.directory, "home"), SAKURACODE_FAUX_SCRIPT: script, SAKURACODE_DOCKER: fakeDocker },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end("");
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /kept in sub: hi/);
  });

  it("without --cwd says what is missing", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", binary, "exec", "--docker", "box", "go"], {
        cwd: sandbox.directory,
        env: { PATH: process.env.PATH ?? "", HOME: sandbox.directory },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.end("");
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /need --cwd/);
  });
});
