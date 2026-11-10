import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpReport, medianReplyHitRate, modelsReport, permissionsReport, statusReport, tokens } from "../src/reports.ts";
import type { LogEntry } from "../src/framework.ts";

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
      usage: { input: 5000, output: 200, cacheRead: 45_000, cacheWrite: 0, turns: 3 },
      medianHitRate: 0.9,
      goal: undefined,
      working: false,
      idleCompaction: "after 5 min idle, from 20,000 tokens",
    });
    for (const expected of ["`abc`", "not restricted", "deepseek-flash via deepseek, thinking medium", "auto:", "| **Redaction** | off |", "1,000 of 128,000", "99% left", "| **Input** | 50.0k tokens: 45.0k cached, 5.0k new |", "90.0% of input tokens from the cache; median reply 90.0% (3 replies", "| **Output** | 200 tokens |", "idle"]) assert.ok(text.includes(expected), expected);
    assert.ok(!text.includes(" in, "), "no ambiguous \"in\" figure left");
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

  it("shows tokens the short way", () => {
    assert.deepEqual([0, 999, 1000, 12_345, 99_999, 100_000, 999_999, 1_000_000, 6_400_000, 135_000_000].map(tokens), ["0", "999", "1.0k", "12.3k", "100.0k", "100k", "1.00M", "1.00M", "6.40M", "135.00M"]);
  });

  it("status says there are no requests before the first reply", () => {
    const text = statusReport({
      sessionId: "a", sessionFile: "f", cwd: "/", provider: "p", model: "m", thinking: undefined, permissions: "auto", redaction: false,
      context: { tokens: 0, window: 100, free: 100, compactAt: undefined }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 },
      goal: undefined, working: false, idleCompaction: "off",
    });
    assert.ok(text.includes("| **Input** | none yet |") && text.includes("no requests yet"));
  });

  it("names cache writes when a provider reports them", () => {
    const text = statusReport({
      sessionId: "a", sessionFile: "f", cwd: "/", provider: "p", model: "m", thinking: undefined, permissions: "auto", redaction: false,
      context: { tokens: 0, window: 100, free: 100, compactAt: undefined }, usage: { input: 1000, output: 10, cacheRead: 8000, cacheWrite: 1000, turns: 2 },
      goal: undefined, working: false, idleCompaction: "off",
    });
    assert.ok(text.includes("10.0k tokens: 8.0k cached, 1.0k new, 1.0k written to the cache"));
    assert.ok(text.includes("80.0% of input tokens from the cache"));
  });

  it("the median hit rate counts model replies only", () => {
    const reply = (input: number, cacheRead: number): LogEntry => ({ type: "message", id: "x", parentId: null, ts: 0, message: { role: "assistant", content: [], ts: 0, usage: { input, output: 1, cacheRead, cacheWrite: 0 } } });
    const entries: LogEntry[] = [
      reply(100, 0), // 0 %
      reply(10, 90), // 90 %
      reply(1, 99), // 99 %
      { type: "usage", id: "u", parentId: null, ts: 0, kind: "compaction", usage: { input: 1000, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: "message", id: "t", parentId: null, ts: 0, message: { role: "tool", content: [], ts: 0 } },
    ];
    assert.equal(medianReplyHitRate(entries), 0.9);
    assert.equal(medianReplyHitRate([reply(1, 1), reply(0, 1)]), 0.75);
    assert.equal(medianReplyHitRate([]), undefined);
  });
});
