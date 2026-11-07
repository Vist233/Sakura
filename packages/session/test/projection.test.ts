import { describe, expect, it } from "vitest";
import { COMPACTION_PREFIX } from "@sakura/kernel";
import type { LogEntry } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { projectMessages } from "../src/projection.ts";
import { buildConversation, entry, text, textOf } from "./helpers.ts";

const seeds = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);

describe("projection: plain conversations", () => {
  for (const seed of seeds(40)) {
    it(`keeps every message in order (seed ${seed})`, () => {
      const count = 1 + (seed % 17);
      const { entries, texts, ids } = buildConversation(seed, count);
      const messages = projectMessages(entries);
      expect(messages.map(textOf)).toEqual(ids.map((id) => texts.get(id)));
    });
  }
});

describe("projection: compaction", () => {
  for (const seed of seeds(40, 100)) {
    it(`replaces history before the first kept entry with the summary (seed ${seed})`, () => {
      const count = 6 + (seed % 15);
      const rng = createRng(seed);
      const { entries, texts, ids } = buildConversation(seed, count);
      const keepFrom = rng.int(1, count - 1);
      const compaction = entry("c1", ids[count - 1] ?? null, {
        type: "compaction",
        summary: `summary ${seed}`,
        firstKeptEntryId: ids[keepFrom] ?? "",
        tokensBefore: 1234,
      });
      const messages = projectMessages([...entries, compaction]);
      expect(messages).toHaveLength(1 + (count - keepFrom));
      expect(textOf(messages[0]!)).toBe(`${COMPACTION_PREFIX}\n\n${`summary ${seed}`}`);
      expect(messages[0]?.role).toBe("user");
      expect(messages.slice(1).map(textOf)).toEqual(ids.slice(keepFrom).map((id) => texts.get(id)));
    });
  }

  for (const seed of seeds(10, 200)) {
    it(`only the latest compaction counts (seed ${seed})`, () => {
      const { entries, ids } = buildConversation(seed, 12);
      const first = entry("c1", "e12", { type: "compaction", summary: "old", firstKeptEntryId: "e6", tokensBefore: 1 });
      const second = entry("c2", "c1", { type: "compaction", summary: "new", firstKeptEntryId: ids[9] ?? "", tokensBefore: 2 });
      const messages = projectMessages([...entries, first, second]);
      expect(textOf(messages[0]!)).toContain("new");
      expect(messages).toHaveLength(1 + 3);
    });
  }

  it("falls back to everything after the compaction when the kept id is unknown", () => {
    const { entries } = buildConversation(1, 4);
    const compaction = entry("c1", "e4", { type: "compaction", summary: "s", firstKeptEntryId: "missing", tokensBefore: 1 });
    const after = entry("e5", "c1", { type: "message", message: { role: "user", content: text("later"), ts: 1 } });
    expect(
      projectMessages([...entries, compaction, after])
        .map(textOf)
        .slice(1),
    ).toEqual(["later"]);
  });
});

describe("projection: context edits", () => {
  for (const seed of seeds(30, 300)) {
    it(`applies replacements and removals (seed ${seed})`, () => {
      const count = 4 + (seed % 9);
      const rng = createRng(seed);
      const { entries, texts, ids } = buildConversation(seed, count);
      const target = ids[rng.int(0, count - 1)] ?? "";
      const remove = rng.chance(0.5);
      const edit: LogEntry = entry("x1", ids[count - 1] ?? null, {
        type: "context_edit",
        targetId: target,
        replacement: remove ? null : text("edited"),
      });
      const messages = projectMessages([...entries, edit]);
      const expected = ids.flatMap((id) => (id === target ? (remove ? [] : ["edited"]) : [texts.get(id)]));
      expect(messages.map(textOf)).toEqual(expected);
    });
  }
});

describe("projection: pinned instructions", () => {
  for (const seed of seeds(30, 400)) {
    it(`pinned entries stay first, even after compaction (seed ${seed})`, () => {
      const rng = createRng(seed);
      const pinned = entry("p1", null, { type: "custom_message", customType: "agents_md", content: text("RULES"), pinned: true });
      const conversation = buildConversation(seed, 8);
      const chain = conversation.entries.map((item, index) => ({ ...item, parentId: index === 0 ? "p1" : item.parentId }));
      let entries: LogEntry[] = [pinned, ...chain];
      if (rng.chance(0.5)) {
        entries = [...entries, entry("c1", "e8", { type: "compaction", summary: "s", firstKeptEntryId: "e5", tokensBefore: 1 })];
      }
      const messages = projectMessages(entries);
      expect(textOf(messages[0]!)).toBe("RULES");
      expect(messages.filter((message) => textOf(message) === "RULES")).toHaveLength(1);
    });
  }
});

describe("projection: entries that never reach the model", () => {
  const hidden: Array<Record<string, unknown>> = [
    { type: "usage", kind: "compaction", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { type: "custom", customType: "x", data: { a: 1 } },
    { type: "tool_started", toolCallId: "t1", toolName: "bash" },
    { type: "paused", reason: "budget" },
    { type: "goal", goal: { objective: "o", status: "active", humanStreak: 0 } },
  ];
  for (const [index, body] of hidden.entries()) {
    for (const seed of seeds(4, index * 10)) {
      it(`ignores ${String(body.type)} entries (case ${seed})`, () => {
        const { entries, texts, ids } = buildConversation(seed, 4);
        const extra = entry("h1", "e4", body);
        expect(projectMessages([...entries, extra]).map(textOf)).toEqual(ids.map((id) => texts.get(id)));
      });
    }
  }

  it("turns unpinned custom messages into user messages", () => {
    const note = entry("n1", null, { type: "custom_message", customType: "signal", content: text("changed") });
    expect(projectMessages([note])).toEqual([{ role: "user", content: text("changed"), ts: 1000 }]);
  });
});

describe("projection: tool results", () => {
  for (let seed = 1; seed <= 20; seed++) {
    it(`orders results by the order of the calls (seed ${seed})`, () => {
      const rng = createRng(seed);
      const count = rng.int(2, 6);
      const ids = Array.from({ length: count }, (_, index) => `call${index}`);
      const assistant = entry("a1", null, {
        type: "message",
        message: { role: "assistant", ts: 1, content: ids.map((id) => ({ type: "tool_call", id, name: "read", args: {} })) },
      });
      const finishOrder = [...ids].sort(() => rng.next() - 0.5);
      let parent = "a1";
      const results = finishOrder.map((id, index) => {
        const item = entry(`r${index}`, parent, {
          type: "message",
          message: { role: "tool", ts: 1, toolCallId: id, content: text(`result of ${id}`) },
        });
        parent = `r${index}`;
        return item;
      });
      const projected = projectMessages([assistant, ...results]);
      expect(projected.slice(1).map((message) => message.toolCallId)).toEqual(ids);
    });
  }
});

describe("projection: usage after compaction", () => {
  for (let seed = 1; seed <= 10; seed++) {
    it(`drops reported usage from kept messages that came before the compaction (seed ${seed})`, () => {
      const { entries } = buildConversation(seed, 8);
      const withUsage = entries.map((item) =>
        item.type === "message" && item.message.role === "assistant" ? { ...item, message: { ...item.message, usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } } } : item,
      ) as LogEntry[];
      const compaction = entry("c1", "e8", { type: "compaction", summary: "s", firstKeptEntryId: "e5", tokensBefore: 1 });
      const later = entry("e9", "c1", { type: "message", message: { role: "assistant", content: text("new"), ts: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
      const messages = projectMessages([...withUsage, compaction, later]);
      expect(messages.slice(0, -1).every((message) => message.usage === undefined)).toBe(true);
      expect(messages.at(-1)?.usage).toBeDefined();
    });
  }
});
