import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { estimateTokens, planCompaction } from "../src/compaction.ts";
import type { CompactionConfig } from "../src/compaction.ts";
import type { LogEntry, Message } from "../src/index.ts";

// The cut is the newest user or assistant message that keeps at least keepRecentTokens (never a tool result, never the first entry).
const config: CompactionConfig = { reserveTokens: 100, keepRecentTokens: 200 };
const msg = (role: Message["role"], chars: number, extra: Partial<Message> = {}): Message => ({ role, content: [{ type: "text", text: "x".repeat(chars) }], ts: 1, ...extra });
const call = (id: string): Message => ({ role: "assistant", ts: 1, content: [{ type: "tool_call", id, name: "bash", args: {} }] });

function chain(messages: Message[]): LogEntry[] {
  return messages.map((message, index) => ({ id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, ts: 1, type: "message" as const, message }));
}
const tokens = (messages: Message[]) => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
const indexOf = (branch: LogEntry[], id: string) => branch.findIndex((entry) => entry.id === id);

/** `early` messages with user turns, then one more user message, then `steps` pairs of tool call and result, then a final assistant message. */
function longAgentRun(steps: number, resultChars = 400): Message[] {
  const messages: Message[] = [msg("user", 400), msg("assistant", 400), msg("user", 400), msg("assistant", 400), msg("user", 400)];
  for (let step = 0; step < steps; step++) messages.push(call(`t${step}`), msg("tool", resultChars, { toolCallId: `t${step}` }));
  messages.push(msg("assistant", 400));
  return messages;
}

describe("planCompaction: the four shapes", () => {
  it("one old user message and then 150 assistant and tool entries: one compaction frees down to about keepRecentTokens", () => {
    const messages = longAgentRun(75); // 150 entries after the user message, about 100 tokens per result
    const branch = chain(messages);
    const plan = planCompaction(branch, config);
    expect(plan?.splitTurn).toBe(true);
    const kept = tokens(messages.slice(indexOf(branch, plan!.firstKeptEntryId)));
    expect(kept).toBeGreaterThanOrEqual(config.keepRecentTokens);
    expect(kept).toBeLessThan(config.keepRecentTokens + 120); // one message and its result more than needed, at most
  });
  it("user messages close together: the cut is the newest message that keeps enough, a user message when that is the one", () => {
    const messages = [msg("user", 400), msg("assistant", 400), msg("user", 400), msg("assistant", 400), msg("user", 400), msg("assistant", 400)];
    // e5 keeps 100, e4 (user) keeps 200: enough
    expect(planCompaction(chain(messages), config)).toEqual({ firstKeptEntryId: "e4", splitTurn: false });
  });
  it("a long turn inside the recent part: the cut falls inside it and splits the turn", () => {
    const messages = [msg("user", 400), msg("assistant", 400), msg("user", 400), ...Array.from({ length: 10 }, () => msg("assistant", 400))];
    const plan = planCompaction(chain(messages), config);
    expect(plan).toEqual({ firstKeptEntryId: "e11", splitTurn: true });
  });
  it("a single huge tool result at the end: the cut is before the call that made it, and the call stays with its result", () => {
    const messages = [msg("user", 400), msg("assistant", 400), msg("user", 400), call("big"), msg("tool", 20_000, { toolCallId: "big" })];
    const plan = planCompaction(chain(messages), config);
    expect(plan).toEqual({ firstKeptEntryId: "e3", splitTurn: true });
  });
});

describe("planCompaction: boundaries", () => {
  it("never cuts on a tool result, even when that is exactly where the tokens run out", () => {
    const messages = [msg("user", 40), msg("assistant", 40), call("a"), msg("tool", 800, { toolCallId: "a" }), msg("assistant", 40)];
    const branch = chain(messages);
    const plan = planCompaction(branch, { reserveTokens: 1, keepRecentTokens: 150 });
    expect(messages[indexOf(branch, plan!.firstKeptEntryId)]!.role).not.toBe("tool");
  });
  it("never cuts at the first entry", () => {
    const branch = chain([msg("user", 4000), ...Array.from({ length: 6 }, () => msg("assistant", 400))]);
    expect(planCompaction(branch, config)?.firstKeptEntryId).not.toBe("e0");
  });
  it("a history smaller than keepRecentTokens (a manual compaction) cuts at the newest user message, as before", () => {
    const branch = chain([msg("user", 40), msg("assistant", 40), msg("user", 40), msg("assistant", 40)]);
    expect(planCompaction(branch, { reserveTokens: 1, keepRecentTokens: 1e9 })).toEqual({ firstKeptEntryId: "e2", splitTurn: false });
  });
  it("one message only: nothing to summarise", () => {
    expect(planCompaction(chain([msg("user", 4000)]), config)).toBeUndefined();
  });
});

describe("planCompaction: for random logs the kept part is the smallest suffix that is big enough", () => {
  for (let seed = 1; seed <= 300; seed++) {
    it(`the kept part is the shortest valid suffix of at least keepRecentTokens, or there is none (seed ${seed})`, () => {
      const rng = createRng(seed);
      const messages: Message[] = [];
      let step = 0;
      const length = rng.int(2, 120);
      while (messages.length < length) {
        const kind = rng.int(0, 9);
        if (kind === 0) messages.push(msg("user", rng.int(40, 800)));
        else if (kind <= 5) {
          messages.push(call(`t${step}`), msg("tool", rng.int(40, 4000), { toolCallId: `t${step++}` }));
        } else messages.push(msg("assistant", rng.int(40, 800)));
      }
      const branch = chain(messages);
      const keep = rng.int(50, 1500);
      const plan = planCompaction(branch, { reserveTokens: 1, keepRecentTokens: keep });
      // the valid boundaries: user or assistant messages after the first entry
      const valid = messages.flatMap((message, index) => (index > 0 && (message.role === "user" || message.role === "assistant") ? [index] : []));
      const big = valid.filter((index) => tokens(messages.slice(index)) >= keep);
      if (big.length === 0) {
        // nothing is big enough (the whole log is nearly smaller than keep): only the short-history fallback may apply
        if (valid.length === 0) expect(plan).toBeUndefined();
        return;
      }
      const index = indexOf(branch, plan!.firstKeptEntryId);
      expect(index).toBe(Math.max(...big)); // the newest, so the smallest suffix
      expect(messages[index]!.role).not.toBe("tool");
      expect(plan!.splitTurn).toBe(messages[index]!.role !== "user");
      // a call is never separated from its results
      const calls = new Set(messages.slice(index).flatMap((message) => message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : []))));
      for (const message of messages.slice(index)) if (message.toolCallId) expect(calls.has(message.toolCallId)).toBe(true);
    });
  }
});
