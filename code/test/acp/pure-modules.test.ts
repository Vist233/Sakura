import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initializeResult, readClientFeatures } from "../../src/acp/capabilities.ts";
import { promptText } from "../../src/acp/content.ts";
import { createLogger, logLevelFromEnv } from "../../src/acp/log.ts";
import { outcomeOf, safeErrorText } from "../../src/acp/stop-reasons.ts";
import { AcpError } from "../../src/acp/types.ts";

describe("content (L1)", () => {
  const cases: Array<[string, Parameters<typeof promptText>[0], string]> = [
    ["one text block", [{ type: "text", text: "hello" }], "hello"],
    ["text blocks are joined with a blank line", [{ type: "text", text: "a" }, { type: "text", text: "b" }], "a\n\nb"],
    ["a file link becomes an @mention", [{ type: "resource_link", uri: "file:///work/src/a%20b.ts", name: "a b.ts" }], "@/work/src/a b.ts"],
    ["another link stays a Markdown link", [{ type: "resource_link", uri: "https://example.com/x", name: "x" }], "[x](https://example.com/x)"],
    ["an image leaves a note", [{ type: "image", data: "AAAA", mimeType: "image/png" }], "[a image attachment was sent but is not supported yet]"],
    ["nothing at all", [], ""],
    ["whitespace only", [{ type: "text", text: "  \n" }], ""],
    ["a malformed block does not throw", [{ type: "text" }, { type: "resource_link" }], "[a text attachment was sent but is not supported yet]\n\n[a resource_link attachment was sent but is not supported yet]"],
  ];
  for (const [name, blocks, expected] of cases) it(name, () => assert.equal(promptText(blocks), expected));

  it("a malformed file URI falls back to a link", () => {
    assert.equal(promptText([{ type: "resource_link", uri: "file://%zz", name: "bad" }]), "[bad](file://%zz)");
  });
});

describe("stop reasons (L1)", () => {
  it("maps every run result", () => {
    assert.deepEqual(outcomeOf({ reason: "done" }, false), { result: { stopReason: "end_turn" } });
    assert.deepEqual(outcomeOf({ reason: "cancelled" }, false), { result: { stopReason: "cancelled" } });
    assert.deepEqual(outcomeOf({ reason: "error", error: "AbortError" }, true), { result: { stopReason: "cancelled" } }, "an abort after a cancel request is a cancel");
    assert.deepEqual(outcomeOf({ reason: "done" }, true), { result: { stopReason: "cancelled" } });
  });

  for (const reason of ["approval", "quota", "budget", "input", "blocked"] as const) {
    it(`a pause for ${reason} is a refusal with a note`, () => {
      const outcome = outcomeOf({ reason: "paused", pause: reason }, false);
      assert.equal(outcome.result.stopReason, "refusal");
      assert.ok((outcome.notice ?? "").length > 10);
    });
  }

  it("a failed run is an error with the message", () => {
    assert.throws(() => outcomeOf({ reason: "error", error: "boom" }, false), (error) => error instanceof AcpError && error.code === -32603 && /boom/.test(error.message));
    assert.throws(() => outcomeOf({ reason: "error" }, false), /unknown error/);
  });

  it("safeErrorText removes credentials and cuts long text", () => {
    assert.equal(safeErrorText("Authorization: Bearer abc.def-123 failed"), "Authorization: [removed] failed");
    assert.ok(!safeErrorText("key sk-1234567890abcdef used").includes("sk-1234567890abcdef"));
    assert.ok(!safeErrorText("x-api-key=SECRET123 end").includes("SECRET123"));
    assert.ok(safeErrorText("a".repeat(2000)).length <= 501);
    assert.equal(safeErrorText("two\n\nlines"), "two lines");
  });
});

describe("capabilities (L1)", () => {
  it("reads what the client advertised, treating anything else as unsupported", () => {
    assert.deepEqual({ ...readClientFeatures({ fs: { readTextFile: true, writeTextFile: false }, terminal: true }) }, { readTextFile: true, writeTextFile: false, terminal: true });
    for (const junk of [undefined, null, 5, "x", [], { fs: 3 }, { fs: { readTextFile: "yes" } }]) {
      assert.deepEqual({ ...readClientFeatures(junk) }, { readTextFile: false, writeTextFile: false, terminal: false });
    }
  });

  it("the features value is frozen", () => assert.throws(() => Object.assign(readClientFeatures({}), { terminal: true })));

  it("answers initialize with version 1 whatever the client asks", () => {
    for (const asked of [0, 1, 2, 99]) assert.equal(initializeResult({ protocolVersion: asked }, { name: "n", title: "T", version: "1.0.0" }).protocolVersion, 1);
  });
});

describe("log (L1)", () => {
  it("writes JSON lines at or above the level and nothing when off", () => {
    const lines: string[] = [];
    const log = createLogger((line) => void lines.push(line), "warn", "m");
    log.debug("no");
    log.info("no");
    log.warn("yes", { session: "s1", n: 2 });
    log.child("sub").error("also");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual([first.level, first.module, first.message, first.session, first.n], ["warn", "m", "yes", "s1", 2]);
    assert.equal(JSON.parse(lines[1]!).module, "sub");
    const quiet: string[] = [];
    createLogger((line) => void quiet.push(line), "off").error("x");
    assert.equal(quiet.length, 0);
  });

  it("reads the level from the environment, defaulting to warn", () => {
    assert.deepEqual(["debug", " INFO ", "off", "error", "nonsense", undefined].map(logLevelFromEnv), ["debug", "info", "off", "error", "warn", "warn"]);
  });
});
