import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpReport, modelsReport, permissionsReport, statusReport } from "../src/reports.ts";

describe("reports", () => {
  it("status lists the facts the owner asked to see", () => {
    const text = statusReport({
      sessionId: "abc",
      sessionFile: "/s/abc.jsonl",
      cwd: "/work",
      provider: "deepseek",
      model: "deepseek-flash",
      thinking: "medium",
      permissions: "auto",
      redaction: false,
      context: { tokens: 1000, window: 128000, free: 127000, compactAt: 100000 },
      usage: { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0, turns: 3 },
      goal: undefined,
      working: false,
    });
    for (const expected of ["`abc`", "not restricted", "deepseek-flash via deepseek, thinking medium", "auto:", "| **Redaction** | off |", "1,000 of 128,000", "99% left", "5,000 in, 200 out", "3 replies", "idle"]) assert.ok(text.includes(expected), expected);
  });

  it("models marks the current provider and missing keys without showing keys", () => {
    const text = modelsReport(
      [
        { name: "deepseek", definition: { baseUrl: "u", model: "deepseek-flash", keyEnv: "DEEPSEEK_API_KEY", contextWindow: 1 }, keyPresent: true, builtin: true },
        { name: "opencode", definition: { baseUrl: "u", model: "deepseek-v4.1-flash", keyEnv: "OPENCODE_API_KEY", contextWindow: 1 }, keyPresent: false, builtin: true },
      ],
      { provider: "deepseek", model: "deepseek-flash" },
    );
    assert.match(text, /▶ `deepseek`/);
    assert.match(text, /OPENCODE_API_KEY` \*\*not set\*\*/);
  });

  it("permissions lists the presets and the redaction state", () => {
    const text = permissionsReport("strict", true);
    assert.match(text, /▶ `strict`/);
    assert.match(text, /Redaction is \*\*on\*\*/);
  });

  it("mcp explains how to configure when there are none", () => {
    assert.match(mcpReport({}), /No MCP servers/);
    assert.match(mcpReport({ files: { ok: false, toolCount: 0, error: "spawn failed" } }), /failed: spawn failed/);
  });
});
