import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { exitCodeFor, runExec } from "../src/exec-mode.ts";
import type { ExecOptions } from "../src/exec-mode.ts";
import { createSessionStore } from "../src/session-store.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";
import { scriptedClient } from "./support/scripted-client.ts";
import type { Script } from "./support/scripted-client.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) }, out: () => out.join(""), err: () => err.join("") };
}

describe("exec mode", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  const run = async (script: Script, options: Partial<ExecOptions> = {}) => {
    const io = capture();
    const code = await runExec(
      { prompt: "do it", json: false, render: false, quiet: false, color: false, ...options },
      { controller: { settings: { ...DEFAULT_SETTINGS, permissions: "full-access" }, cwd: sandbox.directory, home: undefined, env: {}, store: createSessionStore(join(sandbox.directory, "s")), clients: { agent: scriptedClient(script) } }, stdout: io.stdout, stderr: io.stderr },
    );
    return { code, io };
  };

  it("writes the final reply to stdout as Markdown and progress to stderr", async () => {
    const { code, io } = await run([{ toolCalls: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "## Done\n\n- ran `echo hi`" }]);
    assert.equal(code, 0);
    assert.equal(io.out(), "## Done\n\n- ran `echo hi`\n");
    assert.match(io.err(), /✓ bash echo hi/);
  });

  it("renders the Markdown when asked to (a terminal)", async () => {
    const { io } = await run([{ text: "## Done\n\n- item" }], { render: true });
    assert.match(io.out(), /Done\n\n• item/);
    assert.ok(!io.out().includes("##"));
  });

  it("--json writes the session line, every event and a result line", async () => {
    const { code, io } = await run([{ text: "hello" }], { json: true });
    assert.equal(code, 0);
    const lines = io.out().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].permissions, "full-access");
    assert.ok(lines.some((line) => line.type === "run_start"));
    assert.ok(lines.some((line) => line.type === "message_end" && line.message.role === "assistant"));
    assert.deepEqual(lines.at(-1), { type: "result", reason: "done", finalMessage: "hello" });
  });

  it("exits 1 with the error when the model fails, 2 when paused", async () => {
    const failing = await run(() => {
      throw new Error("provider exploded");
    });
    assert.equal(failing.code, 1);
    assert.match(failing.io.err(), /Error: .*provider exploded/);
    assert.equal(exitCodeFor({ reason: "paused", pause: "approval" }), 2);
    assert.equal(exitCodeFor({ reason: "cancelled" }), 130);
  });

  it("--output-last-message writes the final reply to a file", async () => {
    const file = join(sandbox.directory, "last.md");
    await run([{ text: "final words" }], { outputLastMessage: file });
    assert.equal(await readFile(file, "utf8"), "final words\n");
  });

  it("--quiet leaves stderr empty", async () => {
    const { io } = await run([{ toolCalls: [{ name: "bash", args: { command: "true" } }] }, { text: "ok" }], { quiet: true });
    assert.equal(io.err(), "");
  });

  it("a cancel from outside ends the run with 130", async () => {
    const io = capture();
    let cancel: () => void = () => undefined;
    const running = runExec(
      { prompt: "wait", json: false, render: false, quiet: true, color: false },
      { controller: { settings: { ...DEFAULT_SETTINGS, permissions: "full-access" }, cwd: sandbox.directory, home: undefined, env: {}, store: createSessionStore(join(sandbox.directory, "s")), clients: { agent: scriptedClient([{ hang: true }]) } }, stdout: io.stdout, stderr: io.stderr, onCancelable: (fn) => (cancel = fn) },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    cancel();
    assert.equal(await running, 130);
    assert.match(io.err(), /Cancelled/);
  });
});
