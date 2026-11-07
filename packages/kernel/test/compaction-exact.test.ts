// Exact-value tests for compaction.ts. They exist because mutation testing (Stryker) showed that the loop-based tests
// accepted wrong arithmetic and wrong boundaries: these pin the numbers down.
import { describe, expect, it } from "vitest";
import { contextTokens, estimateTokens, planCompaction, shouldCompact } from "../src/compaction.ts";
import type { LogEntry, Message } from "../src/index.ts";

const text = (chars: number): Message["content"] => [{ type: "text", text: "x".repeat(chars) }];
const msg = (role: Message["role"], chars: number, extra: Partial<Message> = {}): Message => ({ role, content: text(chars), ts: 1, ...extra });
const entry = (id: string, parentId: string | null, message: Message): LogEntry => ({ id, parentId, ts: 1, type: "message", message });
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const config = { reserveTokens: 100, keepRecentTokens: 200 };

/** Entries e0..eN with the given roles and sizes (characters). */
function branchOf(specs: Array<[Message["role"], number]>): LogEntry[] {
  return specs.map(([role, chars], index) => entry(`e${index}`, index === 0 ? null : `e${index - 1}`, msg(role, chars)));
}

describe("estimateTokens", () => {
  it("counts four characters per token, rounded up", () => {
    expect(estimateTokens(msg("user", 8))).toBe(2);
    expect(estimateTokens(msg("user", 9))).toBe(3);
    expect(estimateTokens(msg("user", 0))).toBe(0);
  });
  it("a tool call counts its name and its arguments", () => {
    const call: Message = { role: "assistant", ts: 1, content: [{ type: "tool_call", id: "c", name: "abcd", args: { k: "vvvv" } }] };
    // name 4 + {"k":"vvvv"} 12 = 16 characters = 4 tokens
    expect(estimateTokens(call)).toBe(4);
  });
  it("a tool call without arguments counts the name and the two quote marks of an empty value", () => {
    const call: Message = { role: "assistant", ts: 1, content: [{ type: "tool_call", id: "c", name: "abcd", args: undefined }] };
    expect(estimateTokens(call)).toBe(Math.ceil((4 + '""'.length) / 4));
  });
  it("an image costs a flat 4000 characters (1000 tokens)", () => {
    expect(estimateTokens({ role: "user", ts: 1, content: [{ type: "image", mediaType: "image/png", ref: "r" }] })).toBe(1000);
  });
  it("provider data counts its serialised size", () => {
    const part = { type: "provider", vendor: "v", data: { a: "bbbbbbbb" } } as Message["content"][number];
    expect(estimateTokens({ role: "assistant", ts: 1, content: [part] })).toBe(Math.ceil(JSON.stringify({ a: "bbbbbbbb" }).length / 4));
  });
  it("parts add up", () => {
    expect(estimateTokens({ role: "user", ts: 1, content: [...text(4), ...text(4)] })).toBe(2);
  });
});

describe("contextTokens", () => {
  it("without reported usage it is the estimate of everything", () => {
    expect(contextTokens([msg("user", 40), msg("assistant", 40)])).toBe(20);
  });
  it("uses the last reported usage (input + output + cache read + cache write) plus what came after", () => {
    const messages = [msg("user", 400), msg("assistant", 400, { usage: usage(1000, 200, 30, 4) }), msg("user", 40)];
    expect(contextTokens(messages)).toBe(1000 + 200 + 30 + 4 + 10);
  });
  it("a usage on the very first message counts too", () => {
    expect(contextTokens([msg("assistant", 400, { usage: usage(7, 3) }), msg("user", 40)])).toBe(10 + 10);
  });
  it("only the newest usage counts", () => {
    const messages = [msg("assistant", 4, { usage: usage(500, 0) }), msg("user", 4), msg("assistant", 4, { usage: usage(900, 0) })];
    expect(contextTokens(messages)).toBe(900);
  });
  it("an empty list is zero", () => {
    expect(contextTokens([])).toBe(0);
  });
});

describe("shouldCompact", () => {
  const window = 1000;
  const limit = window - config.reserveTokens; // 900
  const at = (tokens: number) => [msg("user", 4), msg("assistant", 4, { usage: usage(tokens, 0) })];
  it("is false at exactly the limit and true one token above", () => {
    expect(shouldCompact(at(limit), window, config)).toBe(false);
    expect(shouldCompact(at(limit + 1), window, config)).toBe(true);
  });
  it("never for a single message, however big", () => {
    expect(shouldCompact([msg("user", 100_000)], window, config)).toBe(false);
  });
  it("two messages are enough", () => {
    expect(shouldCompact([msg("user", 4000), msg("assistant", 4000)], window, config)).toBe(true);
  });
});

describe("planCompaction", () => {
  it("nothing to do for an empty or one-message branch", () => {
    expect(planCompaction([], config)).toBeUndefined();
    expect(planCompaction(branchOf([["user", 4000]]), config)).toBeUndefined();
  });

  it("cuts at the newest user message that keeps at least keepRecentTokens, and never at the first entry", () => {
    // tokens: e0 user 100, e1 asst 100, e2 user 100, e3 asst 100, e4 user 100, e5 asst 100 (each 400 chars)
    const branch = branchOf([
      ["user", 400],
      ["assistant", 400],
      ["user", 400],
      ["assistant", 400],
      ["user", 400],
      ["assistant", 400],
    ]);
    // keeping from e4: 200 tokens after (e4+e5) = exactly keepRecentTokens (200) -> allowed
    expect(planCompaction(branch, config)).toEqual({ firstKeptEntryId: "e4", splitTurn: false });
  });

  it("exactly keepRecentTokens is enough; one token fewer is not", () => {
    const branch = branchOf([
      ["user", 400],
      ["assistant", 400],
      ["user", 400],
      ["assistant", 400],
    ]);
    expect(planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 200 })?.firstKeptEntryId).toBe("e2");
    // asking for more than the tail holds moves the cut further back
    expect(planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 201 })?.firstKeptEntryId).toBe("e1");
  });

  it("when nothing keeps enough tokens it still cuts, at the newest user message after the first entry", () => {
    const branch = branchOf([
      ["user", 40],
      ["assistant", 40],
      ["user", 40],
      ["assistant", 40],
    ]);
    expect(planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 10_000 })).toEqual({ firstKeptEntryId: "e2", splitTurn: false });
  });

  it("when nothing keeps enough tokens and only assistant messages follow the first entry, the cut splits a turn at the newest one", () => {
    const branch = branchOf([
      ["user", 40],
      ["assistant", 40],
      ["assistant", 40],
    ]);
    expect(planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 10_000 })).toEqual({ firstKeptEntryId: "e2", splitTurn: true });
  });

  it("prefers a user message over a newer assistant message and marks a cut at an assistant as a split turn", () => {
    const onlyAssistant = branchOf([
      ["user", 400],
      ["assistant", 400],
      ["assistant", 400],
      ["assistant", 400],
    ]);
    expect(planCompaction(onlyAssistant, config)).toEqual({ firstKeptEntryId: "e2", splitTurn: true });
    const mixed = branchOf([
      ["user", 400],
      ["assistant", 400],
      ["user", 400],
      ["assistant", 400],
      ["assistant", 400],
    ]);
    expect(planCompaction(mixed, config)).toEqual({ firstKeptEntryId: "e2", splitTurn: false });
  });

  it("never cuts at a tool result", () => {
    const branch = branchOf([
      ["user", 400],
      ["assistant", 400],
      ["tool", 4000],
      ["assistant", 400],
    ]);
    const plan = planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 1 });
    expect(plan && branch.find((candidate) => candidate.id === plan.firstKeptEntryId && candidate.type === "message" && candidate.message.role === "tool")).toBeFalsy();
  });

  it("after an earlier compaction only the part that was kept is considered", () => {
    const branch: LogEntry[] = [
      ...branchOf([
        ["user", 400],
        ["assistant", 400],
        ["user", 400],
        ["assistant", 400],
      ]),
      { id: "c1", parentId: "e3", ts: 1, type: "compaction", summary: "s", firstKeptEntryId: "e2", tokensBefore: 1 },
      entry("e5", "c1", msg("user", 400)),
      entry("e6", "e5", msg("assistant", 400)),
    ];
    const plan = planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 1 });
    expect(plan?.firstKeptEntryId).toBe("e5");
  });

  it("after a compaction whose kept tail is a single message there is nothing to summarise", () => {
    const branch: LogEntry[] = [
      ...branchOf([
        ["user", 400],
        ["assistant", 400],
        ["user", 400],
        ["assistant", 400],
      ]),
      { id: "c1", parentId: "e3", ts: 1, type: "compaction", summary: "s", firstKeptEntryId: "e3", tokensBefore: 1 },
    ];
    expect(planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 1 })).toBeUndefined();
  });

  it("when the earlier compaction's kept entry is gone, counting starts right after the compaction entry", () => {
    const branch: LogEntry[] = [
      ...branchOf([
        ["user", 400],
        ["assistant", 400],
      ]),
      { id: "c1", parentId: "e1", ts: 1, type: "compaction", summary: "s", firstKeptEntryId: "missing", tokensBefore: 1 },
      entry("e3", "c1", msg("user", 400)),
      entry("e4", "e3", msg("assistant", 400)),
      entry("e5", "e4", msg("user", 400)),
    ];
    const plan = planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 1 });
    expect(plan?.firstKeptEntryId).toBe("e5");
  });

  it("only the newest compaction decides where to start", () => {
    const branch: LogEntry[] = [
      ...branchOf([
        ["user", 400],
        ["assistant", 400],
        ["user", 400],
        ["assistant", 400],
      ]),
      { id: "c1", parentId: "e3", ts: 1, type: "compaction", summary: "s", firstKeptEntryId: "e0", tokensBefore: 1 },
      entry("e5", "c1", msg("user", 400)),
      { id: "c2", parentId: "e5", ts: 1, type: "compaction", summary: "s2", firstKeptEntryId: "e5", tokensBefore: 1 },
      entry("e7", "c2", msg("assistant", 400)),
      entry("e8", "e7", msg("user", 400)),
      entry("e9", "e8", msg("assistant", 400)),
    ];
    const plan = planCompaction(branch, { reserveTokens: 100, keepRecentTokens: 1 });
    expect(plan?.firstKeptEntryId).toBe("e8");
  });

  it("non-message entries are skipped", () => {
    const branch: LogEntry[] = [
      entry("e0", null, msg("user", 400)),
      { id: "n1", parentId: "e0", ts: 1, type: "custom", customType: "x", data: 1 },
      entry("e2", "n1", msg("assistant", 400)),
      entry("e3", "e2", msg("user", 400)),
      entry("e4", "e3", msg("assistant", 400)),
    ];
    expect(planCompaction(branch, config)).toEqual({ firstKeptEntryId: "e3", splitTurn: false });
  });
});
