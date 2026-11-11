import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initializeResult } from "../../src/acp/capabilities.ts";
import { MAX_IMAGE_BASE64, MAX_IMAGES, MAX_RESOURCE_TEXT, promptContent } from "../../src/acp/content.ts";
import { describeCheck, goalChecks } from "../../src/acp/goal-notes.ts";
import { createLogger, logLevelFromEnv } from "../../src/acp/log.ts";
import { outcomeOf, safeErrorText } from "../../src/acp/stop-reasons.ts";
import { AcpError } from "../../src/acp/types.ts";

describe("content (L1)", () => {
  const textOf = (blocks: Parameters<typeof promptContent>[0]) => promptContent(blocks).text;
  const cases: Array<[string, Parameters<typeof promptContent>[0], string]> = [
    ["one text block", [{ type: "text", text: "hello" }], "hello"],
    ["text blocks are joined with a blank line", [{ type: "text", text: "a" }, { type: "text", text: "b" }], "a\n\nb"],
    ["a file link becomes an @mention", [{ type: "resource_link", uri: "file:///work/src/a%20b.ts", name: "a b.ts" }], "@/work/src/a b.ts"],
    ["another link stays a Markdown link", [{ type: "resource_link", uri: "https://example.com/x", name: "x" }], "[x](https://example.com/x)"],
    ["an embedded text resource is quoted with its address", [{ type: "resource", resource: { uri: "file:///w/n.md", text: "# Notes" } }], "Contents of file:///w/n.md:\n```\n# Notes\n```"],
    ["a binary resource leaves a note", [{ type: "resource", resource: { uri: "file:///w/b.bin", blob: "AAAA" } }], "[file:///w/b.bin was sent as binary data, which the agent does not read]"],
    ["audio leaves a note", [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }], "[an attachment of type audio was sent but is not supported]"],
    ["nothing at all", [], ""],
    ["whitespace only", [{ type: "text", text: "  \n" }], ""],
    ["a malformed block does not throw", [{ type: "text" }, { type: "resource_link" }, { type: "resource" }, { type: "image" }], "[an attachment of type text was sent but is not supported]\n\n[an attachment of type resource_link was sent but is not supported]\n\n[a resource was sent as binary data, which the agent does not read]\n\n[an attachment of type image was sent but is not supported]"],
  ];
  for (const [name, blocks, expected] of cases) it(name, () => assert.equal(textOf(blocks), expected));

  it("a malformed file URI falls back to a link", () => {
    assert.equal(textOf([{ type: "resource_link", uri: "file://%zz", name: "bad" }]), "[bad](file://%zz)");
  });

  it("images come back apart, with limits", () => {
    const one = promptContent([{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
    assert.deepEqual(one, { text: "look", images: [{ data: "AAAA", mimeType: "image/png" }] });
    assert.deepEqual(promptContent([{ type: "image", data: "AAAA", mimeType: "image/png" }]).text, "");
    const many = promptContent(Array.from({ length: MAX_IMAGES + 2 }, () => ({ type: "image", data: "AAAA", mimeType: "image/png" })));
    assert.equal(many.images.length, MAX_IMAGES);
    assert.match(many.text, /more than 10 images/);
    assert.match(promptContent([{ type: "image", data: "A".repeat(MAX_IMAGE_BASE64 + 1), mimeType: "image/png" }]).text, /too large/);
  });

  it("a long embedded text is cut with a note", () => {
    const text = promptContent([{ type: "resource", resource: { uri: "u", text: "x".repeat(MAX_RESOURCE_TEXT + 7) } }]).text;
    assert.match(text, /7 more characters not shown/);
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

describe("goal notes (L1)", () => {
  const check = (data: unknown) => ({ id: "g", parentId: null, ts: 0, type: "custom", customType: "goal_check", data }) as unknown as import("../../src/framework.ts").LogEntry;
  it("reads the checks from a log and describes the unfinished ones", () => {
    const checks = goalChecks([
      check({ verdict: "continue", items: [{ status: "done", text: "a", note: "" }, { status: "todo", text: "the tests pass", note: "not run yet" }] }),
      check({ verdict: "needs_human", items: [{ status: "human", text: "approve the plan", note: "" }] }),
      check({ verdict: "complete", items: [{ status: "done", text: "a", note: "" }] }),
      check({ verdict: 5 }),
      check(null),
      { id: "x", parentId: null, ts: 0, type: "custom", customType: "other", data: {} } as never,
    ]);
    assert.deepEqual(checks.map((entry) => entry.verdict), ["continue", "needs_human", "complete"]);
    assert.equal(describeCheck(checks[0]!), "\n\nGoal check: the goal is not finished yet. Remaining items:\n- the tests pass (not run yet)\n");
    assert.match(describeCheck(checks[1]!)!, /need you to act or decide:\n- approve the plan/);
    assert.equal(describeCheck(checks[2]!), undefined);
  });
  it("tolerates malformed items", () => {
    assert.deepEqual(goalChecks([check({ verdict: "continue", items: [5, null, { text: "x" }] })])[0]!.items, [{ status: "", text: "x", note: "" }]);
    assert.deepEqual(goalChecks([check({ verdict: "continue", items: "no" })])[0]!.items, []);
  });
});
