import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { contextTokens, estimateTokens, planCompaction, shouldCompact } from "../src/compaction.ts";
import type { LogEntry, Message } from "../src/index.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const config = { reserveTokens: 100, keepRecentTokens: 200 };

function entryFor(id: string, parentId: string | null, message: Message): LogEntry {
  return { id, parentId, ts: 1, type: "message", message };
}
const msg = (role: Message["role"], chars: number, extra: Partial<Message> = {}): Message => ({ role, content: [{ type: "text", text: "x".repeat(chars) }], ts: 1, ...extra });

/** A random conversation of turns: user, then assistant (maybe with tool calls and results). */
function conversation(seed: number, turns: number, chars = 400): { branch: LogEntry[]; roles: string[] } {
  const rng = createRng(seed);
  const branch: LogEntry[] = [];
  const roles: string[] = [];
  let parent: string | null = null;
  const add = (message: Message) => {
    const id = `e${branch.length}`;
    branch.push(entryFor(id, parent, message));
    roles.push(message.role);
    parent = id;
  };
  for (let turn = 0; turn < turns; turn++) {
    add(msg("user", rng.int(40, chars)));
    const calls = rng.int(0, 3);
    if (calls > 0) {
      add({ role: "assistant", ts: 1, content: Array.from({ length: calls }, (_, index) => ({ type: "tool_call" as const, id: `t${turn}_${index}`, name: "read", args: {} })) });
      for (let index = 0; index < calls; index++) add(msg("tool", rng.int(40, chars), { toolCallId: `t${turn}_${index}` }));
    }
    add(msg("assistant", rng.int(40, chars)));
  }
  return { branch, roles };
}

describe("estimateTokens and contextTokens", () => {
  for (const chars of [0, 3, 4, 5, 40, 400, 4001]) {
    it(`estimates ${chars} characters as ${Math.ceil(chars / 4)} tokens`, () => {
      expect(estimateTokens(msg("user", chars))).toBe(Math.ceil(chars / 4));
    });
  }
  it("counts tool calls and images", () => {
    expect(estimateTokens({ role: "assistant", ts: 1, content: [{ type: "tool_call", id: "a", name: "read", args: { path: "x" } }] })).toBeGreaterThan(0);
    expect(estimateTokens({ role: "user", ts: 1, content: [{ type: "image", mediaType: "image/png", ref: "a" }] })).toBe(1000);
  });
  it("uses reported usage and adds an estimate for what came after", () => {
    const withUsage: Message = { ...msg("assistant", 40), usage: { input: 1000, output: 50, cacheRead: 200, cacheWrite: 0 } };
    expect(contextTokens([msg("user", 40), withUsage])).toBe(1250);
    expect(contextTokens([msg("user", 40), withUsage, msg("user", 400)])).toBe(1350);
  });
  it("falls back to estimates without any usage", () => {
    expect(contextTokens([msg("user", 400), msg("assistant", 400)])).toBe(200);
  });
  for (const window of [1000, 5000, 100000]) {
    it(`shouldCompact compares with the window (${window})`, () => {
      const used: Message = { ...msg("assistant", 4), usage: { input: window - 50, output: 10, cacheRead: 0, cacheWrite: 0 } };
      expect(shouldCompact([msg("user", 4), used], window, { reserveTokens: 100, keepRecentTokens: 1 })).toBe(true);
      const small: Message = { ...used, usage: { input: window - 500, output: 10, cacheRead: 0, cacheWrite: 0 } };
      expect(shouldCompact([msg("user", 4), small], window, { reserveTokens: 100, keepRecentTokens: 1 })).toBe(false);
    });
  }
  it("never compacts a single message", () => {
    expect(shouldCompact([{ ...msg("user", 10), usage: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } }], 1000, config)).toBe(false);
  });
});

describe("planCompaction on generated conversations", () => {
  for (const seed of range(80)) {
    it(`cuts at a user message, keeps recent tokens and never splits a tool call (seed ${seed})`, () => {
      const turns = 3 + (seed % 12);
      const { branch, roles } = conversation(seed, turns);
      const plan = planCompaction(branch, config);
      if (!plan) return;
      const index = branch.findIndex((entry) => entry.id === plan.firstKeptEntryId);
      expect(index).toBeGreaterThan(0);
      expect(roles[index]).not.toBe("tool");
      expect(plan.splitTurn).toBe(roles[index] !== "user");
      // the kept part is at least keepRecentTokens unless that was impossible
      const kept = branch.slice(index).reduce((sum, entry) => sum + (entry.type === "message" ? estimateTokens(entry.message) : 0), 0);
      const olderUserBoundaryExists = roles.slice(1, index).includes("user");
      if (kept < config.keepRecentTokens) expect(olderUserBoundaryExists).toBe(false);
      // every tool result in the kept part still has its call in the kept part
      const keptIds = new Set(branch.slice(index).flatMap((entry) => (entry.type === "message" ? entry.message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : [])) : [])));
      for (const entry of branch.slice(index)) {
        if (entry.type === "message" && entry.message.toolCallId) expect(keptIds.has(entry.message.toolCallId)).toBe(true);
      }
    });
  }

  it("returns nothing for a conversation that is too short", () => {
    expect(planCompaction([entryFor("a", null, msg("user", 10))], config)).toBeUndefined();
    expect(planCompaction([], config)).toBeUndefined();
  });

  for (const seed of range(15, 100)) {
    it(`a second plan starts after the first compaction (seed ${seed})`, () => {
      const { branch } = conversation(seed, 10);
      const first = planCompaction(branch, config);
      expect(first).toBeDefined();
      const compacted: LogEntry[] = [...branch, { id: "c1", parentId: branch.at(-1)?.id ?? null, ts: 1, type: "compaction", summary: "s", firstKeptEntryId: first!.firstKeptEntryId, tokensBefore: 1 }];
      const more = conversation(seed + 1000, 8).branch.map((entry, index) => ({ ...entry, id: `n${index}`, parentId: index === 0 ? "c1" : `n${index - 1}` }) as LogEntry);
      const second = planCompaction([...compacted, ...more], config);
      if (!second) return;
      const firstIndex = compacted.findIndex((entry) => entry.id === first!.firstKeptEntryId);
      const secondIndex = [...compacted, ...more].findIndex((entry) => entry.id === second.firstKeptEntryId);
      expect(secondIndex).toBeGreaterThan(firstIndex);
    });
  }

  it("falls back to an assistant boundary when the whole history is one turn", () => {
    const branch: LogEntry[] = [entryFor("e0", null, msg("user", 80))];
    let parent = "e0";
    for (let index = 1; index <= 8; index++) {
      const id = `e${index}`;
      branch.push(entryFor(id, parent, msg(index % 2 ? "assistant" : "user", 400)));
      parent = id;
    }
    const noUsers: LogEntry[] = branch.map((entry, index) => (index === 0 || entry.type !== "message" ? entry : { ...entry, message: { ...entry.message, role: "assistant" as const } }));
    const plan = planCompaction(noUsers, config);
    expect(plan?.splitTurn).toBe(true);
  });

  it("with a huge keepRecentTokens it still cuts at the newest possible user message", () => {
    const { branch, roles } = conversation(7, 6);
    const plan = planCompaction(branch, { reserveTokens: 1, keepRecentTokens: 1e9 });
    expect(plan).toBeDefined();
    const index = branch.findIndex((entry) => entry.id === plan!.firstKeptEntryId);
    expect(roles[index]).toBe("user");
  });
});
