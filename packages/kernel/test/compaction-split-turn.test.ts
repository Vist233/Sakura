import { describe, expect, it } from "vitest";
import { COMPACTION_PREFIX } from "../src/index.ts";
import type { LlmRequest, Message } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { finish, setup, text, textOf } from "./helpers.ts";

// A long run of tool calls after one user message: the cut falls inside that turn (a split turn). What the model gets afterwards must be a valid
// conversation for the providers: the first message from the user, every tool result right after the assistant message that made the call.
const lastText = (request: LlmRequest) => textOf(request.messages.at(-1)!);
const isSummaryRequest = (request: LlmRequest) => lastText(request).startsWith("You are writing a context checkpoint");

/** Throws a description of the first thing that would make a provider refuse the conversation. */
function problemsOf(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  if (messages[0]?.role !== "user") problems.push(`starts with ${messages[0]?.role}`);
  let declared = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") declared = new Set(message.content.flatMap((part) => (part.type === "tool_call" ? [part.id] : [])));
    else if (message.role === "tool" && !declared.has(message.toolCallId ?? "")) problems.push(`tool result ${message.toolCallId} at ${index} has no call before it`);
    else if (message.role === "user") declared = new Set();
  }
  return problems;
}

async function longTurn() {
  const log = createMemoryLog();
  await log.append({ type: "custom_message", customType: "agents_md", pinned: true, content: text("RULES") });
  await log.append({ type: "message", message: { role: "user", content: text("old question"), ts: 1 } });
  await log.append({ type: "message", message: { role: "assistant", content: text("old answer"), ts: 1 } });
  await log.append({ type: "message", message: { role: "user", content: text("THE REQUEST: refactor everything"), ts: 1 } });
  for (let step = 0; step < 40; step++) {
    await log.append({ type: "message", message: { role: "assistant", content: [{ type: "tool_call", id: `t${step}`, name: "echo", args: { step } }], ts: 1 } });
    await log.append({ type: "message", message: { role: "tool", content: text(`result ${step} ${"x".repeat(400)}`), toolCallId: `t${step}`, toolName: "echo", ts: 1 } });
  }
  return log;
}

describe("compaction that splits a long turn", () => {
  it("summarises the start of the turn including the user's request, keeps the end, and leaves a valid conversation", async () => {
    const log = await longTurn();
    const built = setup({
      script: (request) => (isSummaryRequest(request) ? { text: "SUMMARY of the request and the first steps" } : { text: "carrying on" }),
      log,
      contextWindow: 2500,
      compaction: { reserveTokens: 100, keepRecentTokens: 300 },
    });
    await log.append({ type: "message", message: { role: "assistant", content: text("working"), ts: 1 } });
    await finish(built.kernel.run(log, "continue"));

    const compaction = (await log.branch()).find((entry) => entry.type === "compaction");
    expect(compaction).toBeDefined();
    const kept = (await log.branch()).find((entry) => entry.id === (compaction as { firstKeptEntryId: string }).firstKeptEntryId)!;
    expect(kept.type === "message" && kept.message.role).toBe("assistant"); // a split turn: the cut is not at a user message

    // the request that asked for the summary contained the user's request, and ended with the checkpoint prompt as a user message
    const summaryRequest = built.llm.requests.find(isSummaryRequest)!;
    expect(summaryRequest.messages.map(textOf).join("\n")).toContain("THE REQUEST: refactor everything");
    expect(summaryRequest.messages.at(-1)!.role).toBe("user");
    expect(problemsOf(summaryRequest.messages)).toEqual([]);

    // the request after it: instructions, the summary, then the kept part that starts with an assistant message
    const after = built.llm.requests.at(-1)!;
    expect(problemsOf(after.messages)).toEqual([]);
    expect(textOf(after.messages[0]!)).toBe("RULES");
    expect(textOf(after.messages[1]!)).toContain(COMPACTION_PREFIX);
    expect(textOf(after.messages[1]!)).toContain("SUMMARY of the request");
    expect(after.messages[2]!.role).toBe("assistant");
    expect(after.messages.map(textOf).join("\n")).not.toContain("old question");
  });
});
