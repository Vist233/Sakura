import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, stripAnsi } from "../src/ansi.ts";
import { contextLeftPercent, formatStatusLine, shortenPath } from "../src/status-line.ts";
import type { StatusInfo } from "../src/status-line.ts";

const base: StatusInfo = { provider: "deepseek", model: "deepseek-flash", thinking: "medium", cwd: "/Users/me/project", home: "/Users/me", contextLeftPercent: 87, permissions: "auto", redaction: false, working: false, queued: 0 };

describe("status line", () => {
  it("shows model, effort, context left and directory like Codex", () => {
    assert.equal(stripAnsi(formatStatusLine(base, 100, true)), "deepseek-flash medium · 87% context left · ~/project");
  });

  it("only mentions permissions, redaction and the queue when they matter", () => {
    const line = stripAnsi(formatStatusLine({ ...base, permissions: "strict", redaction: true, queued: 2 }, 120, false));
    assert.equal(line, "deepseek-flash medium · 87% context left · strict · redaction · 2 queued · ~/project");
  });

  it("omits the context before the first measurement and the effort when unset", () => {
    assert.equal(formatStatusLine({ ...base, contextLeftPercent: undefined, thinking: undefined }, 100, false), "deepseek-flash · ~/project");
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
