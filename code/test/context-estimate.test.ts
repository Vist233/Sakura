import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateAfterCompaction, measureContext } from "../src/context-estimate.ts";
import type { ContextSource } from "../src/context-estimate.ts";
import type { LogEntry } from "../src/framework.ts";

const usage = { input: 90_000, output: 1000, cacheRead: 0, cacheWrite: 0 };
const text = (id: string, role: "user" | "assistant", body: string, withUsage = false): LogEntry =>
  ({ id, parentId: null, ts: 0, type: "message", message: { role, content: [{ type: "text", text: body }], ...(withUsage ? { usage } : {}) } }) as LogEntry;
const compaction = (id: string, firstKeptEntryId: string, summary: string): LogEntry => ({ id, parentId: null, ts: 0, type: "compaction", summary, firstKeptEntryId, tokensBefore: 95_000 });

const source = (branch: LogEntry[], tokens: number): ContextSource => ({
  context: async () => ({ tokens, window: 128_000, free: 128_000 - tokens, compactAt: 106_240 }),
  log: { branch: async () => branch },
});

describe("measureContext", () => {
  it("trusts the framework before any compaction", async () => {
    const measured = await measureContext(source([text("a", "user", "hi"), text("b", "assistant", "yo", true)], 91_000));
    assert.deepEqual(measured, { tokens: 91_000, window: 128_000, estimated: false });
  });

  it("estimates the compacted context while the kept messages still carry old usage", async () => {
    const branch = [text("a", "user", "x".repeat(4000)), text("b", "assistant", "y".repeat(4000), true), text("c", "user", "z".repeat(400)), compaction("d", "c", "s".repeat(800))];
    const measured = await measureContext(source(branch, 91_000));
    assert.equal(measured.estimated, true);
    assert.equal(measured.tokens, 300);
    assert.equal(estimateAfterCompaction(branch), 300);
  });

  it("trusts the framework again once a reply after the compaction reports usage", async () => {
    const branch = [text("a", "user", "x".repeat(400)), compaction("d", "a", "s"), text("e", "user", "q"), text("f", "assistant", "r", true)];
    assert.equal((await measureContext(source(branch, 12_000))).estimated, false);
  });
});
