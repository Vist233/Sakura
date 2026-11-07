import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import type { LlmRequest } from "../src/index.ts";
import { finish, setup, textOf } from "./helpers.ts";

const lastText = (request: LlmRequest) => textOf(request.messages.at(-1)!);
const isCheck = (request: LlmRequest) => lastText(request).startsWith("You are about to stop.");
const isSummary = (request: LlmRequest) => lastText(request).startsWith("You are writing a context checkpoint") || lastText(request).startsWith("The conversation above continues");

const LINES = {
  done: "- [done] it :: proof",
  todo: "- [todo] it :: missing",
  human: "- [human] it :: only a human",
  garbage: "no checklist here",
};

describe("goal: random sequences of checks against a simulation", () => {
  for (let seed = 1; seed <= 150; seed++) {
    it(`ends the way the rules say (seed ${seed})`, async () => {
      const rng = createRng(seed * 104729);
      const length = rng.int(1, 9);
      const kinds = Array.from({ length }, () => rng.pick(["done", "todo", "human", "garbage"] as const));
      kinds.push(rng.pick(["done", "human"] as const)); // the last answer repeats, so it must end the goal
      // simulation of the documented rules
      let streak = 0;
      let expectedChecks = 0;
      let expected: "complete" | "blocked" = "complete";
      for (let step = 0; ; step++) {
        const kind = kinds[Math.min(step, kinds.length - 1)] as keyof typeof LINES;
        expectedChecks++;
        if (kind === "done") break;
        if (kind === "human") {
          streak++;
          if (streak >= 3) {
            expected = "blocked";
            break;
          }
        } else streak = 0;
      }
      let index = 0;
      const built = setup({
        script: (request) => (isCheck(request) ? { text: LINES[kinds[Math.min(index++, kinds.length - 1)] as keyof typeof LINES] } : { text: "working" }),
        goal: { objective: "fuzz goal" },
      });
      const { result } = await finish(built.kernel.run(built.log, "go"));
      expect(built.llm.requests.filter(isCheck)).toHaveLength(expectedChecks);
      const status = ((await built.log.branch()).filter((entry) => entry.type === "goal").at(-1) as unknown as { goal: { status: string } }).goal.status;
      expect(status).toBe(expected);
      expect(result.reason).toBe(expected === "complete" ? "done" : "paused");
    });
  }
});

describe("compaction: random long conversations keep the log valid", () => {
  for (let seed = 1; seed <= 130; seed++) {
    it(`every call has a result and the summary leads the context (seed ${seed})`, async () => {
      const rng = createRng(seed * 7727);
      const calls = rng.int(0, 2);
      const tool = {
        name: "echo",
        description: "d",
        parameters: { type: "object" },
        effect: "read" as const,
        execute: async () => ({ content: [{ type: "text" as const, text: "r".repeat(rng.int(10, 200)) }] }),
      };
      const replyChars = rng.int(100, 500);
      const built = setup({
        script: (request) => {
          if (isSummary(request)) return { text: `SUMMARY ${seed}` };
          if (request.messages.at(-1)?.role === "user" && calls > 0) {
            return { toolCalls: Array.from({ length: calls }, (_, n) => ({ name: "echo", args: { n }, id: `c${request.messages.length}_${n}` })) };
          }
          return { text: "r".repeat(replyChars) };
        },
        contextWindow: 1200,
        compaction: { reserveTokens: 250, keepRecentTokens: rng.int(50, 300) },
        tools: [tool],
      });
      const turns = rng.int(4, 12);
      for (let turn = 0; turn < turns; turn++) {
        const { result } = await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(rng.int(50, 400))}`));
        expect(result.reason).toBe("done");
      }
      const entries = await built.log.branch();
      const called = new Set(entries.flatMap((entry) => (entry.type === "message" ? entry.message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : [])) : [])));
      const answered = new Set(entries.flatMap((entry) => (entry.type === "message" && entry.message.toolCallId ? [entry.message.toolCallId] : [])));
      expect(answered).toEqual(called);
      const compaction = entries.filter((entry) => entry.type === "compaction").at(-1);
      const messages = await built.log.project();
      if (compaction?.type === "compaction") {
        expect(textOf(messages[0]!)).toContain(compaction.summary);
        expect(entries.some((entry) => entry.id === compaction.firstKeptEntryId)).toBe(true);
        // after a compaction no tool result is left without its call in the visible context
        const visibleCalls = new Set(messages.flatMap((message) => message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : []))));
        for (const message of messages) if (message.toolCallId) expect(visibleCalls.has(message.toolCallId)).toBe(true);
      }
    });
  }
});
