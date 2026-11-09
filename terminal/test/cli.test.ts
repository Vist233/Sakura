import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";

const binary = new URL("../bin/sakura-terminal.mjs", import.meta.url).pathname;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the real binary as a child process, so the entry file, argument parsing and exit codes are tested together. */
function runBinary(args: string[], options: { cwd: string; env?: Record<string, string>; stdin?: string }): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", binary, ...args], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: options.cwd, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}

describe("command line", () => {
  let sandbox: Sandbox;
  let env: Record<string, string>;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    env = { SAKURA_HOME: join(sandbox.directory, "home") };
  });
  afterEach(() => sandbox.cleanup());

  const script = async (turns: unknown[]) => {
    const file = join(sandbox.directory, "script.json");
    await writeFile(file, JSON.stringify(turns));
    return { ...env, SAKURA_TERMINAL_FAUX_SCRIPT: file };
  };

  it("--help and --version", async () => {
    const help = await runBinary(["--help"], { cwd: sandbox.directory });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /sakura-terminal exec/);
    assert.match((await runBinary(["--version"], { cwd: sandbox.directory })).stdout, /^\d+\.\d+\.\d+\n$/);
  });

  it("providers lists both built-in providers and whether the key is set, without printing a key", async () => {
    const result = await runBinary(["providers"], { cwd: sandbox.directory, env: { ...env, DEEPSEEK_API_KEY: "sk-secret-value" } });
    assert.match(result.stdout, /deepseek\s+deepseek-flash\s+DEEPSEEK_API_KEY set/);
    assert.match(result.stdout, /opencode\s+deepseek-v4\.1-flash\s+OPENCODE_API_KEY NOT SET/);
    assert.ok(!result.stdout.includes("sk-secret-value"));
  });

  it("exec writes the Markdown reply to stdout and exits 0", async () => {
    const result = await runBinary(["exec", "say hi"], { cwd: sandbox.directory, env: await script([{ text: "# Hi\n\nHello." }]) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "# Hi\n\nHello.\n");
  });

  it("exec --json streams events", async () => {
    const result = await runBinary(["exec", "--json", "say hi"], { cwd: sandbox.directory, env: await script([{ text: "Hello." }]) });
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.equal(lines[0]?.type, "session");
    assert.equal(lines.at(-1)?.type, "result");
  });

  it("exec reads the prompt from stdin", async () => {
    const result = await runBinary(["exec", "-"], { cwd: sandbox.directory, env: await script([{ text: "ok" }]), stdin: "from a pipe\n" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "ok\n");
  });

  it("exec runs tools in the launch directory and can reach outside it", async () => {
    const turns = [{ toolCalls: [{ name: "bash", args: { command: "pwd > made.txt; ls /etc > /dev/null && echo outside-ok >> made.txt" } }] }, { text: "done" }];
    const result = await runBinary(["exec", "--permissions", "full-access", "make a file"], { cwd: sandbox.directory, env: await script(turns) });
    assert.equal(result.code, 0, result.stderr);
    const made = await (await import("node:fs/promises")).readFile(join(sandbox.directory, "made.txt"), "utf8");
    assert.match(made, /outside-ok/);
  });

  it("reports usage errors with exit code 2 and no stack", async () => {
    const result = await runBinary(["exec", "--permissions", "root", "x"], { cwd: sandbox.directory, env });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--permissions must be one of/);
    const empty = await runBinary(["exec"], { cwd: sandbox.directory, env });
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /exec needs a prompt/);
  });

  it("refuses the interactive session without a terminal", async () => {
    const result = await runBinary([], { cwd: sandbox.directory, env });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /needs a terminal/);
  });

  it("explains a missing key without printing anything secret", async () => {
    const result = await runBinary(["exec", "hi"], { cwd: sandbox.directory, env });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no API key found; set one of: DEEPSEEK_API_KEY, OPENCODE_API_KEY/);
  });

  it("a config file with a profile changes the provider, and a bad config is reported", async () => {
    await (await import("node:fs/promises")).mkdir(join(sandbox.directory, "home"), { recursive: true });
    await writeFile(join(sandbox.directory, "home", "config.toml"), 'permissions = "strict"\n[profiles.x]\nprovider = "nope"\n');
    const bad = await runBinary(["exec", "--profile", "x", "hi"], { cwd: sandbox.directory, env });
    assert.match(bad.stderr, /unknown provider "nope"/);
    await writeFile(join(sandbox.directory, "home", "config.toml"), "oops = ");
    const broken = await runBinary(["providers"], { cwd: sandbox.directory, env });
    assert.equal(broken.code, 2);
    assert.match(broken.stderr, /config/);
  });

  it("lists sessions after a run and resumes one with exec --resume", async () => {
    const first = await runBinary(["exec", "first topic"], { cwd: sandbox.directory, env: await script([{ text: "one" }]) });
    assert.equal(first.code, 0, first.stderr);
    const listed = await runBinary(["sessions"], { cwd: sandbox.directory, env });
    assert.match(listed.stdout, /first topic/);
    const second = await runBinary(["exec", "--resume", "last", "--json", "second"], { cwd: sandbox.directory, env: await script([{ text: "two" }]) });
    assert.equal(second.code, 0, second.stderr);
    const after = (await runBinary(["sessions"], { cwd: sandbox.directory, env })).stdout.trim().split("\n");
    assert.equal(after.length, 1, "the run continued the same session");
    const id = after[0]!.split(" ")[0]!;
    const conversation = await (await import("node:fs/promises")).readFile(join(sandbox.directory, "home", "sessions", `${id}.jsonl`), "utf8");
    assert.ok(conversation.includes("first topic") && conversation.includes("second"), "both prompts are in the one session file");
  });
});
