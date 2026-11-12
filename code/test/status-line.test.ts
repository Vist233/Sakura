import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, stripAnsi } from "../src/ansi.ts";
import { contextLeftPercent, formatStatusLine, shortenPath } from "../src/status-line.ts";
import type { StatusInfo } from "../src/status-line.ts";

const base: StatusInfo = { provider: "deepseek", model: "deepseek-flash", thinking: "medium", cwd: "/Users/me/project", home: "/Users/me", contextLeftPercent: 87, permissions: "auto", redaction: false, working: false, queued: 0 };

describe("status line", () => {
  it("shows model, effort, context left and directory like Codex", () => {
    assert.equal(stripAnsi(formatStatusLine(base, 100, true)), "deepseek-flash medium · 87% context left · auto · ~/project");
  });

  it("always shows the review mode, and mentions redaction and the queue only when they matter", () => {
    assert.equal(stripAnsi(formatStatusLine(base, 120, false)), "deepseek-flash medium · 87% context left · auto · ~/project");
    const line = stripAnsi(formatStatusLine({ ...base, permissions: "strict", redaction: true, queued: 2 }, 120, false));
    assert.equal(line, "deepseek-flash medium · 87% context left · strict · redaction · 2 queued · ~/project");
  });

  it("shows the scheduled jobs only while at least one is active", () => {
    assert.equal(stripAnsi(formatStatusLine({ ...base, scheduled: 0 }, 120, false)), "deepseek-flash medium · 87% context left · auto · ~/project");
    assert.equal(stripAnsi(formatStatusLine({ ...base, scheduled: 2, queued: 1 }, 120, false)), "deepseek-flash medium · 87% context left · auto · 1 queued · ⏰ 2 · ~/project");
  });

  it("marks an estimated percentage with a tilde, also in red under 15%", () => {
    assert.equal(stripAnsi(formatStatusLine({ ...base, contextEstimated: true, contextLeftPercent: 38 }, 120, false)), "deepseek-flash medium · ~38% context left · auto · ~/project");
    assert.equal(stripAnsi(formatStatusLine({ ...base, contextEstimated: false }, 120, false)), "deepseek-flash medium · 87% context left · auto · ~/project");
    assert.match(formatStatusLine({ ...base, contextEstimated: true, contextLeftPercent: 9 }, 120, true), /\u001b\[31m~9%/);
  });

  it("colours the mode by risk and shows a pending mode as next turn", () => {
    assert.match(formatStatusLine(base, 120, true), /\u001b\[2mauto/);
    assert.match(formatStatusLine({ ...base, permissions: "strict" }, 120, true), /\u001b\[33mstrict/);
    assert.match(formatStatusLine({ ...base, permissions: "read-only" }, 120, true), /\u001b\[33mread-only/);
    assert.match(formatStatusLine({ ...base, permissions: "full-access" }, 120, true), /\u001b\[31mfull-access/);
    assert.equal(stripAnsi(formatStatusLine({ ...base, pendingPermissions: "strict" }, 120, false)), "deepseek-flash medium · 87% context left · strict (next turn) · ~/project");
  });

  it("omits the context before the first measurement and the effort when unset", () => {
    assert.equal(formatStatusLine({ ...base, contextLeftPercent: undefined, thinking: undefined }, 100, false), "deepseek-flash · auto · ~/project");
  });

  it("never exceeds the width", () => {
    for (const width of [20, 40, 60]) assert.ok(displayWidth(formatStatusLine({ ...base, permissions: "full-access", redaction: true, queued: 9 }, width, false)) <= width);
  });

  it("shortens paths", () => {
    assert.equal(shortenPath("/Users/me/a/b/c/d", "/Users/me", 8), "…/c/d");
    assert.equal(shortenPath("/etc", "/Users/me", 12), "/etc");
    assert.equal(shortenPath("/Users/me", "/Users/me", 12), "~");
  });

  it("computes a clamped percentage", () => {
    assert.equal(contextLeftPercent(25, 100), 25);
    assert.equal(contextLeftPercent(-5, 100), 0);
    assert.equal(contextLeftPercent(1, 0), 0);
  });
});
