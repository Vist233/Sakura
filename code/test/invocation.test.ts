import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInvocation } from "../src/invocation.ts";

describe("invocation", () => {
  it("plain words are an interactive prompt", () => {
    assert.deepEqual(parseInvocation(["fix", "the", "bug"], {}), { mode: "tui", prompt: "fix the bug", resume: undefined, slash: undefined });
    assert.deepEqual(parseInvocation([], { resume: "abc" }), { mode: "tui", prompt: "", resume: "abc", slash: undefined });
  });
  it("exec, with and without resume", () => {
    assert.deepEqual(parseInvocation(["exec", "do", "it"], {}), { mode: "exec", prompt: "do it", resume: undefined });
    assert.deepEqual(parseInvocation(["exec", "resume", "--x"], {}), { mode: "exec", resume: "--x", prompt: "" });
    assert.deepEqual(parseInvocation(["exec", "resume", "abc", "go", "on"], {}), { mode: "exec", resume: "abc", prompt: "go on" });
    assert.deepEqual(parseInvocation(["exec", "resume", "go", "on"], { last: true }), { mode: "exec", resume: "last", prompt: "go on" });
    assert.throws(() => parseInvocation(["exec", "resume"], {}), /needs a session id/);
  });
  it("resume opens the picker without an id", () => {
    assert.deepEqual(parseInvocation(["resume"], {}), { mode: "tui", resume: undefined, prompt: "", slash: "/resume" });
    assert.deepEqual(parseInvocation(["resume", "--x", "more"], {}), { mode: "tui", resume: "--x", prompt: "more", slash: undefined });
    assert.deepEqual(parseInvocation(["resume"], { last: true }), { mode: "tui", resume: "last", prompt: "", slash: undefined });
  });
  it("fork needs a session and types /fork", () => {
    assert.deepEqual(parseInvocation(["fork", "abc"], {}), { mode: "tui", resume: "abc", prompt: "", slash: "/fork" });
    assert.throws(() => parseInvocation(["fork"], {}), /fork needs/);
  });
  it("review builds a prompt for the target", () => {
    const base = parseInvocation(["review", "security"], { base: "main" });
    assert.ok(base.mode === "exec" && base.prompt.includes("git diff main...HEAD") && base.prompt.includes("Focus of this review: security"));
    const commit = parseInvocation(["review"], { commit: "abc123" });
    assert.ok(commit.mode === "exec" && commit.prompt.includes("git show abc123"));
    const none = parseInvocation(["review"], {});
    assert.ok(none.mode === "exec" && none.prompt.includes("untracked"));
    assert.throws(() => parseInvocation(["review"], { base: "a", commit: "b" }), /cannot be used together/);
  });
  it("providers and sessions", () => {
    assert.deepEqual(parseInvocation(["providers"], {}), { mode: "providers" });
  });
});
