// The real binary in a real pseudo-terminal, driven by keystrokes, with a scripted model. What it wrote is replayed on a
// virtual terminal, so the checks are about what a user would see.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";
import { VirtualTerminal } from "./support/vt.ts";

const driver = new URL("./pty/drive.py", import.meta.url).pathname;
const binary = new URL("../bin/sakura-terminal.mjs", import.meta.url).pathname;
const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("real terminal", { skip: !hasPython && "python3 is needed for the pseudo-terminal" }, () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await mkdir(join(sandbox.directory, "work"));
  });
  afterEach(() => sandbox.cleanup());

  async function session(turns: unknown[], steps: unknown[], extraArgs: string[] = [], permissions: string[] = ["--permissions", "full-access"]) {
    const scriptFile = join(sandbox.directory, "script.json");
    const stepsFile = join(sandbox.directory, "steps.json");
    const outputFile = join(sandbox.directory, "out.bin");
    await writeFile(scriptFile, JSON.stringify(turns));
    const reviewerFile = join(sandbox.directory, "reviewer.json");
    await writeFile(reviewerFile, JSON.stringify([{ text: '{"risk_level":"low","user_authorization":"medium","outcome":"allow","rationale":"listing a directory"}' }]));
    await writeFile(stepsFile, JSON.stringify(steps));
    const result = spawnSync("python3", ["-I", driver, stepsFile, outputFile, "80", "24", join(sandbox.directory, "work"), "--", process.execPath, "--disable-warning=ExperimentalWarning", binary, ...permissions, ...extraArgs], {
      env: { PATH: process.env.PATH ?? "", HOME: sandbox.directory, TERM: "xterm-256color", SAKURA_HOME: join(sandbox.directory, "home"), SAKURA_TERMINAL_FAUX_SCRIPT: scriptFile, SAKURA_TERMINAL_FAUX_REVIEWER: reviewerFile },
      encoding: "utf8",
      timeout: 60_000,
    });
    const terminal = new VirtualTerminal(80, 24);
    terminal.write((await readFile(outputFile)).toString("utf8"));
    return { status: result.status, stderr: result.stderr, terminal, screen: terminal.text() };
  }

  it("keeps the prompt and the status line on the bottom rows from the start and while output arrives", async () => {
    const run = await session([{ text: "short **answer**" }], [
      { expect: "Sakura Terminal" },
      { sleep: 0.5 },
      { send: "hello\r" },
      { expect: "short answer", timeout: 15 },
      { sleep: 0.5 },
    ]);
    const screen = run.terminal.screen();
    assert.equal(screen.length, 24);
    assert.match(screen[23]!, /context left|deepseek|opencode|scripted|·/, screen.join("\n"));
    assert.match(screen[22]!, /^›/);
    assert.match(screen[21]!, /^─+$/);
    assert.ok(screen.slice(0, 8).some((line) => line.includes("Sakura Terminal")), "the banner stays at the top");
    assert.ok(screen.some((line) => line.includes("• short answer")));
  });

  it("shows a big paste as a placeholder and sends all of it", async () => {
    const body = Array.from({ length: 60 }, (_, index) => `pasted line ${index}`).join("\n");
    const run = await session([{ text: "seen" }], [
      { expect: "Sakura Terminal" },
      { sleep: 0.5 },
      { send: `\u001b[200~${body}\u001b[201~` },
      { expect: "Pasted Content", timeout: 8 },
      { sleep: 0.3 },
      { send: "\r" },
      { expect: "• seen", timeout: 15 },
      { sleep: 0.5 },
    ]);
    assert.notEqual(run.status, 3, "the placeholder appeared in the composer");
    assert.ok(run.screen.includes("pasted line 0"), "the full text went to the transcript");
    assert.ok(!run.screen.includes("pasted line 59"), "but only its first rows");
    assert.match(run.screen, /… \+\d+ lines/, "the transcript cuts the long message");
  });

  it("full session: prompt, tool call, Markdown reply, /status, and a clean exit", async () => {
    const turns = [
      { toolCalls: [{ name: "bash", args: { command: "echo made > note.txt; exit 3" } }] },
      { text: "The command **failed** with exit code 3.\n\n- file: `note.txt`" },
    ];
    const run = await session(turns, [
      { expect: "Sakura Terminal" },
      { send: "run a failing command\r" },
      { expect: "• file: note\\.txt|note.txt", timeout: 15 },
      { sleep: 0.5 },
      { send: "/status\r" },
      { expect: "Permissions", timeout: 8 },
      { send: "\u0003" },
      { sleep: 0.3 },
      { send: "\u0003" },
      { expect: "Resume it with", timeout: 8 },
    ]);
    assert.equal(run.status, 0, `${run.stderr}\n${run.screen}`);
    assert.match(run.screen, /› run a failing command/);
    assert.match(run.screen, /✗ bash echo made > note\.txt; exit 3 \(exit 3\)/);
    assert.match(run.screen, /The command failed with exit code 3\./);
    assert.ok(!run.screen.includes("**failed**"));
    assert.match(run.screen, /\| *Permissions *\|?|Permissions/);
    assert.match(run.screen, /Resume it with:\n {2}sakura-terminal resume [0-9a-f-]{36}/);
    assert.equal((await readFile(join(sandbox.directory, "work", "note.txt"), "utf8")).trim(), "made");
  });

  it("Esc cancels, then the session goes on", async () => {
    const run = await session(
      [{ hang: true }, { text: "back again" }],
      [{ expect: "Sakura Terminal" }, { send: "hang please\r" }, { expect: "Working \\(" }, { send: "\u001b" }, { expect: "Run cancelled", timeout: 8 }, { send: "next\r" }, { expect: "back again", timeout: 8 }, { send: "\u0004" }, { expect: "Resume it with", timeout: 8 }],
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.screen}`);
    assert.match(run.screen, /Run cancelled\./);
    assert.match(run.screen, /• back again/);
  });

  it("starts with a prompt given on the command line and shows the user's message", async () => {
    const run = await session([{ text: "answered" }], [{ expect: "• answered", timeout: 10 }, { send: "\u0004" }, { expect: "Resume it with", timeout: 8 }], ["tell me something"]);
    assert.equal(run.status, 0, `${run.stderr}\n${run.screen}`);
    assert.match(run.screen, /› tell me something/);
  });

  it("the defaults: review is on, and a read-only command outside the launch directory is allowed by the hard rules", async () => {
    const run = await session(
      [{ toolCalls: [{ name: "bash", args: { command: "ls /etc | head -2" } }] }, { text: "listed" }],
      [{ expect: "Sakura Terminal" }, { send: "list /etc\r" }, { expect: "• listed", timeout: 15 }, { send: "\u0004" }, { expect: "Resume it with", timeout: 8 }],
      [],
      [],
    );
    assert.equal(run.status, 0, `${run.stderr}\n${run.screen}`);
    assert.match(run.screen, /review: {5}on \(auto\)/);
    assert.match(run.screen, /✓ bash ls \/etc \| head -2\n/);
  });
});
