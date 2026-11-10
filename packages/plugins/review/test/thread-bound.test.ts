import { describe, expect, it } from "vitest";
import type { LlmRequest, Log, LogEntry, Message, ToolCall } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient, createRng } from "@sakura/testing";
import { resolvePolicy } from "../src/policy.ts";
import { createReviewer, defaultReviewerLimits, resolveReviewerLimits, seedLines, shorten, transcriptDelta, verdictDigest } from "../src/reviewer.ts";
import { reviewPlugin } from "../src/index.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];
const say = (log: Log, role: "user" | "assistant", value: string) => log.append({ type: "message", message: { role, content: text(value), ts: 1 } });
const answerOf = (outcome: "allow" | "deny", rationale = "ok") => ({ text: JSON.stringify({ risk_level: outcome === "allow" ? "low" : "critical", user_authorization: "high", outcome, rationale }) });
const call = (command: string, id = "c1"): ToolCall => ({ id, name: "bash", args: { command } });
const ctx = (log: Log) => ({ log, signal: new AbortController().signal, tool: () => undefined });
const tokensOf = (messages: readonly Message[]) =>
  Math.ceil(messages.reduce((sum, message) => sum + message.content.reduce((chars, part) => chars + (part.type === "text" ? part.text.length : 0), 0), 0) / 4);
const lastText = (request: LlmRequest) =>
  request.messages
    .at(-1)!
    .content.map((part) => (part.type === "text" ? part.text : ""))
    .join("");
const record = (log: Log, tool: string, outcome: string, reason: string, extra: Record<string, unknown> = {}) =>
  log.append({ type: "custom", customType: "review", data: { callId: "x", tool, outcome, decidedBy: "reviewer", reason, latencyMs: 1, ...extra } });

/** A reviewer that allows everything except commands containing "danger". */
const byContent = (request: LlmRequest) => answerOf(lastText(request).includes("danger") ? "deny" : "allow", "scripted");

describe("shorten", () => {
  it("leaves a short text alone and keeps the head and the tail of a long one, saying how much is missing", () => {
    expect(shorten("short", 100)).toBe("short");
    const long = `HEAD${"x".repeat(10_000)}TAIL`;
    const result = shorten(long, 1000);
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.startsWith("HEAD")).toBe(true);
    expect(result.endsWith("TAIL")).toBe(true);
    expect(result).toMatch(/\[\d+ characters left out\]/);
  });
  for (const max of [1, 5, 40, 100, 1200]) {
    it(`never returns more than the limit plus its own note (limit ${max})`, () => {
      const result = shorten("y".repeat(5000), max);
      expect(result.length).toBeLessThanOrEqual(Math.max(max, 40));
    });
  }
});

describe("entry caps", () => {
  const entries = (...parts: Array<Record<string, unknown>>) => parts.map((part, index) => ({ id: `e${index}`, parentId: index ? `e${index - 1}` : null, ts: 1, ...part })) as unknown as LogEntry[];
  it("a user message, a tool call and the instructions are capped, each with its own limit", () => {
    const lines = transcriptDelta(
      entries(
        { type: "message", message: { role: "user", content: text("U".repeat(10_000)), ts: 1 } },
        { type: "message", message: { role: "assistant", content: [{ type: "tool_call", id: "t", name: "write", args: { path: "a", content: "W".repeat(10_000) } }], ts: 1 } },
        { type: "custom_message", customType: "agents_md", content: text("I".repeat(20_000)) },
      ),
      0,
      "none",
    );
    expect(lines[0]!.length).toBeLessThanOrEqual(defaultReviewerLimits.entryChars + 10);
    expect(lines[1]!.length).toBeLessThanOrEqual(defaultReviewerLimits.entryChars + 40);
    expect(lines[1]).toContain('"path":"a"');
    expect(lines[2]!.length).toBeLessThanOrEqual(defaultReviewerLimits.instructionChars + 40);
  });
  it("the action under review keeps head and tail up to its own, larger limit", async () => {
    const llm = createFauxClient([answerOf("allow")]);
    const command = `echo START ${"a".repeat(50_000)} rm -rf /tmp/END-OF-COMMAND`;
    await createReviewer({ llm, policy: resolvePolicy() }).review(call(command), ctx(createMemoryLog()));
    const sent = lastText(llm.requests[0]!);
    expect(sent).toContain("echo START");
    expect(sent).toContain("END-OF-COMMAND");
    expect(sent).toMatch(/characters left out/);
    expect(sent.length).toBeLessThan(defaultReviewerLimits.actionChars + 400);
    expect(defaultReviewerLimits.actionChars).toBeGreaterThan(defaultReviewerLimits.entryChars);
  });
  it("a short action is sent whole", async () => {
    const llm = createFauxClient([answerOf("allow")]);
    await createReviewer({ llm, policy: resolvePolicy() }).review(call("npm publish"), ctx(createMemoryLog()));
    expect(lastText(llm.requests[0]!)).toContain('"command":"npm publish"');
  });
});

describe("options are checked when they are defined", () => {
  for (const [name, value] of [
    ["zero", 0],
    ["negative", -5],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ] as const) {
    for (const key of Object.keys(defaultReviewerLimits)) {
      it(`${key} ${name} is refused`, () => {
        expect(() => resolveReviewerLimits({ [key]: value })).toThrow(RangeError);
        expect(() => reviewPlugin({ llm: createFauxClient([]), limits: { [key]: value } })).toThrow(key);
      });
    }
  }
  it("defaults are filled in and given values win", () => {
    expect(resolveReviewerLimits()).toEqual(defaultReviewerLimits);
    expect(resolveReviewerLimits({ maxThreadTokens: 100 })).toEqual({ ...defaultReviewerLimits, maxThreadTokens: 100 });
  });
});

describe("the digest of earlier verdicts", () => {
  const logWithRecords = async (count: number) => {
    const log = createMemoryLog();
    for (let index = 0; index < count; index++) await record(log, "bash", index % 3 === 0 ? "deny" : "allow", `reason ${index}`);
    return log;
  };
  it("is the last N, oldest first, one line each, and the same every time", async () => {
    const entries = await (await logWithRecords(30)).branch();
    const digest = verdictDigest(entries, 10);
    expect(digest).toHaveLength(10);
    expect(digest[0]).toBe("[earlier review] bash: allow - reason 20");
    expect(digest.at(-1)).toBe("[earlier review] bash: allow - reason 29");
    expect(verdictDigest(entries, 10)).toEqual(digest);
    expect(digest.every((line) => !line.includes("\n"))).toBe(true);
  });
  it("is shorter when there are fewer records, and empty without any", async () => {
    expect(verdictDigest(await (await logWithRecords(3)).branch(), 10)).toHaveLength(3);
    expect(verdictDigest([], 10)).toEqual([]);
  });
  it("caps a long reason, flattens its lines, leaves out technical failures and ignores other custom entries", async () => {
    const log = createMemoryLog();
    await record(log, "bash", "deny", `${"r".repeat(1000)}\nsecond line`);
    await record(log, "bash", "deny", "could not decide", { technical: true });
    await log.append({ type: "custom", customType: "other", data: { tool: "bash", outcome: "allow" } });
    await record(log, "bash", "maybe", "nonsense outcome");
    const digest = verdictDigest(await log.branch(), 10);
    expect(digest).toHaveLength(1);
    expect(digest[0]!.length).toBeLessThan(260);
  });
});

describe("what a new conversation starts with", () => {
  it("has the instructions, the active goal, the last few user messages and the digest, and nothing older", async () => {
    const log = createMemoryLog();
    await log.append({ type: "custom_message", customType: "agents_md", pinned: true, content: text("RULES") });
    for (let index = 0; index < 12; index++) await say(log, "user", `user message ${index}`);
    await log.append({ type: "custom_message", customType: "goal", pinned: true, content: text("OLD GOAL") });
    const old = (await log.branch()).at(-1)!;
    await log.append({ type: "context_edit", targetId: old.id, replacement: null });
    await log.append({ type: "custom_message", customType: "goal", pinned: true, content: text("NEW GOAL") });
    await record(log, "bash", "allow", "fine");
    const joined = seedLines(await log.branch(), defaultReviewerLimits).join("\n");
    expect(joined).toContain("[project instructions] RULES");
    expect(joined).toContain("[goal] NEW GOAL");
    expect(joined).not.toContain("OLD GOAL");
    expect(joined).toContain("user message 11");
    expect(joined).toContain("user message 7");
    expect(joined).not.toContain("user message 6");
    expect(joined).toContain("[earlier review] bash: allow - fine");
    expect(joined).toContain("left out");
  });
  it("a conversation started on a long saved log (a resumed session) is small", async () => {
    const log = createMemoryLog();
    for (let index = 0; index < 500; index++) {
      await say(log, "user", `request ${index} ${"u".repeat(3000)}`);
      await record(log, "bash", "allow", "fine");
    }
    const llm = createFauxClient([answerOf("allow")]);
    await createReviewer({ llm, policy: resolvePolicy() }).review(call("ls"), ctx(log));
    expect(tokensOf(llm.requests[0]!.messages)).toBeLessThan(6000);
    expect(lastText(llm.requests[0]!)).toContain("request 499");
    expect(lastText(llm.requests[0]!)).not.toContain("request 400");
  });
});

describe("the conversation grows only until the limit, then starts again", () => {
  it("is append-only between resets: each request begins with the previous request and its answer", async () => {
    const llm = createFauxClient(byContent);
    const reviewer = createReviewer({ llm, policy: resolvePolicy() });
    const log = createMemoryLog();
    for (let index = 0; index < 40; index++) {
      await say(log, "user", `step ${index}`);
      await reviewer.review(call(`echo ${index}`, `c${index}`), ctx(log));
    }
    for (let index = 1; index < llm.requests.length; index++) {
      const before = llm.requests[index - 1]!.messages;
      const now = llm.requests[index]!.messages;
      expect(JSON.stringify(now.slice(0, before.length))).toBe(JSON.stringify(before));
      expect(now[before.length]!.role).toBe("assistant");
      expect(now).toHaveLength(before.length + 2);
    }
    expect(llm.requests.at(-1)!.system).toBe(llm.requests[0]!.system);
  });

  it("over 2000 reviews the size stays at the limit plus one action, and it resets many times", async () => {
    const limit = 3000;
    const llm = createFauxClient(byContent);
    const reviewer = createReviewer({ llm, policy: resolvePolicy(), limits: { maxThreadTokens: limit } });
    const log = createMemoryLog();
    const rng = createRng(7);
    let largest = 0;
    let resets = 0;
    for (let index = 0; index < 2000; index++) {
      if (index % 3 === 0) await say(log, "user", `request ${index} ${"u".repeat(rng.int(10, 3000))}`);
      await log.append({ type: "message", message: { role: "assistant", content: [{ type: "tool_call", id: `t${index}`, name: "write", args: { content: "w".repeat(rng.int(10, 9000)) } }], ts: 1 } });
      const command = `echo ${index} ${"c".repeat(rng.int(1, 5000))}`;
      await reviewer.review(call(command, `c${index}`), ctx(log));
      await record(log, "bash", "allow", "scripted");
      const request = llm.requests.at(-1)!;
      largest = Math.max(largest, tokensOf(request.messages));
      if (request.messages.length === 1 && index > 0) resets++;
    }
    const oneAction = Math.ceil(defaultReviewerLimits.actionChars / 4) + 100;
    expect(largest).toBeLessThanOrEqual(limit + oneAction);
    expect(resets).toBeGreaterThan(50);
  }, 120_000);

  it("the verdicts are the same whether the conversation was ever started again or not", async () => {
    const rng = createRng(3);
    const commands = Array.from({ length: 120 }, (_, index) => (rng.int(0, 4) === 0 ? `danger ${index}` : `echo ${index} ${"c".repeat(rng.int(1, 800))}`));
    async function verdicts(limits: { maxThreadTokens: number }) {
      const llm = createFauxClient(byContent);
      const reviewer = createReviewer({ llm, policy: resolvePolicy(), limits });
      const log = createMemoryLog();
      const outcomes: string[] = [];
      for (const [index, command] of commands.entries()) {
        await say(log, "user", `do ${index}`);
        outcomes.push((await reviewer.review(call(command, `c${index}`), ctx(log))).kind);
        await record(log, "bash", outcomes.at(-1)!, "scripted");
      }
      return { outcomes, resets: llm.requests.filter((request, index) => index > 0 && request.messages.length === 1).length };
    }
    const never = await verdicts({ maxThreadTokens: 10_000_000 });
    const often = await verdicts({ maxThreadTokens: 300 });
    expect(never.resets).toBe(0);
    expect(often.resets).toBeGreaterThan(30);
    expect(often.outcomes).toEqual(never.outcomes);
    expect(never.outcomes).toContain("deny");
  });

  it("a compaction in the log starts a new conversation", async () => {
    const llm = createFauxClient([answerOf("allow"), answerOf("allow"), answerOf("allow")]);
    const reviewer = createReviewer({ llm, policy: resolvePolicy() });
    const log = createMemoryLog();
    await say(log, "user", "first");
    await reviewer.review(call("a", "1"), ctx(log));
    await say(log, "user", "second");
    await reviewer.review(call("b", "2"), ctx(log));
    expect(llm.requests[1]!.messages).toHaveLength(3);
    const kept = await say(log, "assistant", "kept");
    await log.append({ type: "compaction", summary: "s", firstKeptEntryId: kept.id, tokensBefore: 1 });
    await reviewer.review(call("c", "3"), ctx(log));
    expect(llm.requests[2]!.messages).toHaveLength(1);
    expect(lastText(llm.requests[2]!)).toContain("left out");
  });

  it("a log that is shorter than what was seen (rewound) starts a new conversation", async () => {
    const llm = createFauxClient([answerOf("allow"), answerOf("allow")]);
    const reviewer = createReviewer({ llm, policy: resolvePolicy() });
    const long = createMemoryLog();
    for (let index = 0; index < 5; index++) await say(long, "user", `m${index}`);
    let seen = 5;
    // one log object (the reviewer keys its conversation by it) whose branch is first five entries long and then two
    const view = { ...long, branch: async () => (await long.branch()).slice(0, seen) } as Log;
    await reviewer.review(call("a", "1"), ctx(view));
    seen = 2;
    await reviewer.review(call("b", "2"), ctx(view));
    expect(llm.requests[1]!.messages).toHaveLength(1);
  });

  it("reset(log) starts it again by hand", async () => {
    const llm = createFauxClient(byContent);
    const reviewer = createReviewer({ llm, policy: resolvePolicy() });
    const log = createMemoryLog();
    await reviewer.review(call("a", "1"), ctx(log));
    reviewer.reset(log);
    await reviewer.review(call("b", "2"), ctx(log));
    expect(llm.requests[1]!.messages).toHaveLength(1);
  });

  it("a review that fails after the conversation was to be started again leaves the old conversation as it was", async () => {
    const llm = createFauxClient([answerOf("allow"), { text: "garbage" }, { text: "garbage" }, answerOf("allow")]);
    const reviewer = createReviewer({ llm, policy: resolvePolicy(), limits: { maxThreadTokens: 400 } });
    const log = createMemoryLog();
    await say(log, "user", "x".repeat(1000));
    await reviewer.review(call("a", "1"), ctx(log));
    await say(log, "user", "y".repeat(1000));
    const failed = await reviewer.review(call("b", "2"), ctx(log));
    expect(failed).toMatchObject({ kind: "deny", technical: true });
    const verdict = await reviewer.review(call("c", "3"), ctx(log));
    expect(verdict.kind).toBe("allow");
    expect(llm.requests).toHaveLength(4);
  });
});
