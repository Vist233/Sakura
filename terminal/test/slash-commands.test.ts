import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMANDS, complete, findCommand, helpMarkdown, parseSlash } from "../src/slash-commands.ts";
import type { CommandHost } from "../src/slash-commands.ts";

function recordingHost(): { host: CommandHost; calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args.map((arg) => String(arg))].join(" "));
    };
  const host = {
    print: record("print"),
    fail: record("fail"),
    help: () => "HELP",
    status: async () => "STATUS",
    models: () => "MODELS",
    switchModel: async (...args: unknown[]) => record("switchModel")(...args),
    permissions: record("permissions"),
    redaction: async (...args: unknown[]) => record("redaction")(...args),
    compact: async () => record("compact")(),
    newSession: async () => record("newSession")(),
    clearScreen: async () => record("clearScreen")(),
    resume: async (...args: unknown[]) => record("resume")(...args),
    fork: async () => record("fork")(),
    undo: async () => record("undo")(),
    runPrompt: record("runPrompt"),
    diff: async () => record("diff")(),
    goal: async (...args: unknown[]) => record("goal")(...args),
    mcp: () => "MCP",
    exit: record("exit"),
  } satisfies CommandHost;
  return { host, calls };
}

const run = async (line: string) => {
  const { host, calls } = recordingHost();
  const parsed = parseSlash(line)!;
  await findCommand(parsed.name)!.run(parsed.args, host);
  return calls;
};

describe("slash commands", () => {
  it("parses commands but not paths", () => {
    assert.deepEqual(parseSlash("/model deepseek"), { name: "model", args: "deepseek" });
    assert.deepEqual(parseSlash("/Status"), { name: "status", args: "" });
    assert.equal(parseSlash("/usr/bin/env is here"), undefined);
    assert.equal(parseSlash("hello /model"), undefined);
    assert.equal(parseSlash("/"), undefined);
  });

  it("finds commands by alias", () => {
    assert.equal(findCommand("quit")?.name, "exit");
    assert.equal(findCommand("approvals")?.name, "permissions");
    assert.equal(findCommand("nope"), undefined);
  });

  it("completes by prefix and stops at a space", () => {
    assert.deepEqual(complete("/re").map((command) => command.name), ["redaction", "resume", "review"]);
    assert.deepEqual(complete("/model x"), []);
    assert.deepEqual(complete("hello"), []);
    assert.equal(complete("/").length, COMMANDS.length);
  });

  it("every command has a unique name and a usage that starts with its name", () => {
    const names = COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    assert.equal(new Set(names).size, names.length);
    for (const command of COMMANDS) assert.ok(command.usage.startsWith(`/${command.name}`));
  });

  it("routes arguments to the host", async () => {
    assert.deepEqual(await run("/model"), ["print MODELS"]);
    assert.deepEqual(await run("/model deepseek"), ["switchModel deepseek undefined"]);
    assert.deepEqual(await run("/model opencode/deepseek-v4.1-flash"), ["switchModel opencode deepseek-v4.1-flash"]);
    assert.deepEqual(await run("/model opencode deepseek-v4.1-flash"), ["switchModel opencode deepseek-v4.1-flash"]);
    assert.deepEqual(await run("/permissions strict"), ["permissions strict"]);
    assert.deepEqual(await run("/permissions"), ["permissions undefined"]);
    assert.deepEqual(await run("/redaction on"), ["redaction on"]);
    assert.deepEqual(await run("/redaction maybe"), ["fail Usage: /redaction [on|off]"]);
    assert.deepEqual(await run("/resume abc"), ["resume abc"]);
    assert.deepEqual(await run("/goal make tests pass"), ["goal make tests pass"]);
    assert.deepEqual(await run("/compact"), ["compact"]);
    assert.deepEqual(await run("/quit"), ["exit"]);
  });

  it("/init and /review start a run with a prompt", async () => {
    const [init] = await run("/init");
    assert.match(init!, /^runPrompt Create an AGENTS\.md/);
    const [review] = await run("/review error handling");
    assert.match(review!, /git diff/);
    assert.match(review!, /Focus of this review: error handling/);
  });

  it("help lists every command", () => {
    const help = helpMarkdown();
    for (const command of COMMANDS) assert.ok(help.includes(`/${command.name}`));
  });
});
