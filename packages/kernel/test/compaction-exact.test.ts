// Exact-value tests for compaction.ts: they pin down the arithmetic and the boundaries that the loop-based tests leave open.
import { describe, expect, it } from "vitest";
import { contextTokens, defaultCompaction, estimateTokens, planCompaction, reservedTokens, shouldCompact } from "../src/compaction.ts";
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

describe("the free part of the window", () => {
  const fixed = { reserveTokens: 16_384, keepRecentTokens: 20_000 };
  const shared = { ...fixed, reserveFraction: 0.17 };

  it("the default asks for 17% free, but never less than 16384 tokens", () => {
    expect(defaultCompaction.reserveFraction).toBe(0.17);
    expect(defaultCompaction.reserveTokens).toBe(16_384);
  });

  const cases: Array<[number, number]> = [
    [32_000, 16_384], // the fixed amount is larger
    [64_000, 16_384],
    [96_000, 16_384], // 17% is 16320
    [96_376, 16_384], // 17% is 16383.92, rounded up to 16384
    [96_377, 16_385], // the share takes over
    [128_000, 21_760],
    [200_000, 34_000],
    [1_000_000, 170_000],
  ];
  for (const [window, reserved] of cases) {
    it(`window ${window}: ${reserved} tokens stay free`, () => {
      expect(reservedTokens(window, shared)).toBe(reserved);
    });
  }

  it("compacts above 83% of a 128k window and not at it", () => {
    const limit = 128_000 - 21_760; // 106240
    const at = (tokens: number) => [msg("user", 4), msg("assistant", 4, { usage: usage(tokens, 0) })];
    expect(shouldCompact(at(limit), 128_000, shared)).toBe(false);
    expect(shouldCompact(at(limit + 1), 128_000, shared)).toBe(true);
  });

  it("a small window keeps the fixed amount, as before", () => {
    const at = (tokens: number) => [msg("user", 4), msg("assistant", 4, { usage: usage(tokens, 0) })];
    expect(shouldCompact(at(32_000 - 16_384), 32_000, shared)).toBe(false);
    expect(shouldCompact(at(32_000 - 16_384 + 1), 32_000, shared)).toBe(true);
  });

  it("without a share only the fixed amount counts", () => {
    expect(reservedTokens(128_000, fixed)).toBe(16_384);
  });

  for (const odd of [0, -0.5, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "0.5" as unknown as number]) {
    it(`a share of ${String(odd)} counts as none`, () => {
      expect(reservedTokens(128_000, { ...fixed, reserveFraction: odd })).toBe(16_384);
    });
  }

  it("a fixed amount larger than the share wins", () => {
    expect(reservedTokens(128_000, { reserveTokens: 50_000, reserveFraction: 0.17, keepRecentTokens: 1 })).toBe(50_000);
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

  it("cuts at the newest user or assistant message that keeps keepRecentTokens, and marks a cut at an assistant as a split turn (an older user message is not preferred)", () => {
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
    // e3 (assistant) is the newest message that keeps 200 tokens; the user message e2 before it is not looked for
    expect(planCompaction(mixed, config)).toEqual({ firstKeptEntryId: "e3", splitTurn: true });
    const userIsNewestEnough = branchOf([
      ["user", 400],
      ["assistant", 400],
      ["assistant", 400],
      ["assistant", 400],
      ["user", 400],
      ["assistant", 400],
    ]);
    expect(planCompaction(userIsNewestEnough, config)).toEqual({ firstKeptEntryId: "e4", splitTurn: false });
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

  it("after an earlier compaction only the part that was kept is considered (the cut is the newest message that keeps keepRecentTokens, here the last assistant message, not the user message before it)", () => {
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
    expect(plan?.firstKeptEntryId).toBe("e6");
    expect(plan?.splitTurn).toBe(true);
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

  it("only the newest compaction decides where to start (the cut is the newest message that keeps keepRecentTokens, an assistant message, not the user message before it)", () => {
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
    expect(plan?.firstKeptEntryId).toBe("e9");
    expect(plan?.splitTurn).toBe(true);
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
