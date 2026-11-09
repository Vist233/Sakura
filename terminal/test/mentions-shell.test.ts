import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expandMentions } from "../src/mentions.ts";
import { runShell } from "../src/shell.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";

describe("mentions and shell", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeFile(join(sandbox.directory, "a.txt"), "x");
    await mkdir(join(sandbox.directory, "dir"));
  });
  afterEach(() => sandbox.cleanup());

  it("names existing files and directories, ignores the rest and trailing punctuation", async () => {
    const result = await expandMentions("look at @a.txt, @dir and @missing.txt or mail me@example.com", sandbox.directory, undefined);
    assert.deepEqual(result.files, [join(sandbox.directory, "a.txt"), `${join(sandbox.directory, "dir")}/`]);
    assert.match(result.text, /^look at @a\.txt/);
    assert.match(result.text, /- .*a\.txt/);
  });

  it("leaves a prompt without mentions alone", async () => {
    assert.deepEqual(await expandMentions("plain", sandbox.directory, undefined), { text: "plain", files: [] });
  });

  it("runs a shell command with its real exit code", async () => {
    assert.deepEqual(await runShell("echo out; echo err >&2; exit 3", sandbox.directory), { output: "out\nerr\n", exitCode: 3, timedOut: false });
    assert.equal((await runShell("pwd", sandbox.directory)).output.trim().endsWith(sandbox.directory.split("/").pop()!), true);
  });

  it("can be aborted", async () => {
    const controller = new AbortController();
    const running = runShell("sleep 5", sandbox.directory, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    assert.notEqual(result.exitCode, 0);
  });
});
