import { describe, expect, it } from "vitest";
import { ProviderError, COMPACTION_PREFIX } from "../src/index.ts";
import type { LlmRequest, Plugin } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { createRng } from "@sakura/testing";
import { finish, setup, textOf } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const lastText = (request: LlmRequest) => textOf(request.messages.at(-1)!);
const isFirst = (request: LlmRequest) => lastText(request).startsWith("You are writing a context checkpoint");
const isUpdate = (request: LlmRequest) => lastText(request).startsWith("The conversation above continues from an earlier checkpoint");
const compacting = { reserveTokens: 200, keepRecentTokens: 150 };

/** Normal replies are long; summary requests get a recognisable summary. */
function chatty(replyChars: number) {
  return (request: LlmRequest) => {
    if (isFirst(request)) return { text: "SUMMARY-FIRST" };
    if (isUpdate(request)) return { text: "SUMMARY-UPDATE" };
    return { text: "r".repeat(replyChars) };
  };
}

async function converse(built: ReturnType<typeof setup>, turns: number, userChars = 400) {
  for (let turn = 0; turn < turns; turn++) await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(userChars)}`));
}
const entriesOf = async (log: { branch(): Promise<readonly { type: string }[]> }, type: string) => (await log.branch()).filter((entry) => entry.type === type);

describe("compaction during a run", () => {
  for (const seed of range(30)) {
    it(`compacts when the context nears the window and keeps going (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const built = setup({ script: chatty(rng.int(300, 600)), contextWindow: 1000, compaction: compacting });
      await converse(built, rng.int(5, 9), rng.int(300, 500));
      const compactions = await entriesOf(built.log, "compaction");
      expect(compactions.length).toBeGreaterThanOrEqual(1);
      expect(await entriesOf(built.log, "usage")).not.toHaveLength(0);
      const messages = await built.log.project();
      expect(textOf(messages[0]!)).toContain(COMPACTION_PREFIX);
      expect(messages.length).toBeLessThan(2 * 9);
    });
  }

  it("a share of the window can be asked for, and a fixed amount given alone is taken as it is", async () => {
    const count = async (compaction: { reserveTokens: number; reserveFraction?: number; keepRecentTokens: number }) => {
      const built = setup({ script: chatty(400), contextWindow: 1000, compaction });
      await converse(built, 3, 400); // about 200 tokens a turn
      return (await entriesOf(built.log, "compaction")).length;
    };
    expect(await count({ reserveTokens: 200, keepRecentTokens: 150 })).toBe(0); // limit 800, reached only after four turns
    expect(await count({ reserveTokens: 200, reserveFraction: 0.5, keepRecentTokens: 150 })).toBeGreaterThanOrEqual(1); // limit 500
  });

  it("emits a compaction event", async () => {
    const built = setup({ script: chatty(500), contextWindow: 1000, compaction: compacting });
    const seen: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const outcome = await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`));
      seen.push(...outcome.events.map((event) => event.type));
    }
    expect(seen).toContain("compaction");
  });

  for (const seed of range(15, 100)) {
    it(`the summary request is the same conversation plus the prompt, with the same tools and system (seed ${seed})`, async () => {
      const built = setup({
        script: chatty(500),
        contextWindow: 1000,
        compaction: compacting,
        tools: [{ name: "echo", description: "d", parameters: { type: "object" }, effect: "read", execute: async () => ({ content: [] }) }],
      });
      await converse(built, 6, 300 + seed);
      const summaryRequest = built.llm.requests.find(isFirst)!;
      const normalBefore = built.llm.requests[built.llm.requests.indexOf(summaryRequest) - 1]!;
      expect(summaryRequest.system).toBe("system prompt");
      expect(summaryRequest.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(summaryRequest.messages.slice(0, 2).map(textOf)).toEqual(normalBefore.messages.slice(0, 2).map(textOf));
    });
  }

  it("after a compaction the model sees the summary, then the recent messages", async () => {
    const built = setup({ script: chatty(500), contextWindow: 1000, compaction: compacting });
    await converse(built, 7);
    const next = built.llm.requests.filter((request) => !isFirst(request) && !isUpdate(request)).at(-1)!;
    expect(textOf(next.messages[0]!)).toContain("SUMMARY-");
    expect(textOf(next.messages.at(-1)!).startsWith("6:")).toBe(true);
  });

  it("a second compaction uses the update prompt with the earlier summary", async () => {
    const built = setup({ script: chatty(500), contextWindow: 1000, compaction: compacting });
    await converse(built, 14);
    const update = built.llm.requests.find(isUpdate);
    expect(update).toBeDefined();
    expect(lastText(update!)).toContain("<previous-summary>\nSUMMARY-FIRST");
  });

  it("pinned messages stay in front after compaction", async () => {
    const log = createMemoryLog();
    await log.append({ type: "custom_message", customType: "agents_md", pinned: true, content: [{ type: "text", text: "PROJECT RULES" }] });
    const built = setup({ script: chatty(500), contextWindow: 1000, compaction: compacting, log });
    await converse(built, 8);
    expect(textOf(built.llm.requests.filter((request) => !isFirst(request) && !isUpdate(request)).at(-1)!.messages[0]!)).toBe("PROJECT RULES");
    expect((await entriesOf(log, "compaction")).length).toBeGreaterThan(0);
  });

  it("can be switched off", async () => {
    const built = setup({ script: chatty(500), contextWindow: 1000, compaction: false });
    await converse(built, 8);
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
    expect(built.llm.requests.some(isFirst)).toBe(false);
  });

  it("does nothing while the context is small", async () => {
    const built = setup({ script: chatty(20), contextWindow: 1000, compaction: compacting });
    await converse(built, 5, 20);
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
  });

  it("an empty summary leaves the log alone and the run still finishes", async () => {
    const built = setup({ script: (request) => (isFirst(request) ? { text: "  " } : { text: "r".repeat(500) }), contextWindow: 1000, compaction: compacting });
    await converse(built, 6);
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
    expect((await built.log.project()).length).toBe(12);
  });

  for (const kind of ["rate_limit", "network", "overloaded", "other"] as const) {
    it(`a ${kind} error while summarising does not stop the run`, async () => {
      const built = setup({
        script: (request) => {
          if (isFirst(request)) return { error: new ProviderError(kind, "summary failed") };
          return { text: "r".repeat(500) };
        },
        contextWindow: 1000,
        compaction: compacting,
      });
      let last = "";
      for (let turn = 0; turn < 6; turn++) last = (await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`))).result.reason;
      expect(last).toBe("done");
    });
  }

  it("summary requests pass through the request hook", async () => {
    let hooked = 0;
    const p: Plugin = {
      name: "spy",
      setup: (api) =>
        api.on("request", (request) => {
          if (isFirst(request)) hooked++;
        }),
    };
    const built = setup({ script: chatty(500), contextWindow: 1000, compaction: compacting, plugins: [p] });
    await converse(built, 7);
    expect(hooked).toBeGreaterThan(0);
  });
});

describe("compaction after a context overflow", () => {
  async function seeded(script: Parameters<typeof setup>[0]["script"]) {
    const built = setup({ script, compaction: { reserveTokens: 1, keepRecentTokens: 30 } });
    for (let turn = 0; turn < 5; turn++) {
      await built.log.append({ type: "message", message: { role: "user", content: [{ type: "text", text: `old ${turn} ${"x".repeat(200)}` }], ts: 1 } });
      await built.log.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `ans ${turn} ${"y".repeat(200)}` }], ts: 1 } });
    }
    return built;
  }

  for (const variant of range(5, 200)) {
    it(`compacts and retries once when the provider reports overflow (variant ${variant})`, async () => {
      let overflowed = false;
      const built = await seeded((request) => {
        if (isFirst(request)) return { text: "SUMMARY-FIRST" };
        if (!overflowed) {
          overflowed = true;
          return { error: new ProviderError("context_overflow", "too long") };
        }
        return { text: "ok" };
      });
      const outcome = await finish(built.kernel.run(built.log, "new question"));
      expect(outcome.result.reason).toBe("done");
      expect((await entriesOf(built.log, "compaction")).length).toBe(1);
    });
  }

  it("gives up when overflow happens again right after compacting", async () => {
    const built = await seeded((request) => (isFirst(request) || isUpdate(request) ? { text: "SUMMARY-FIRST" } : { error: new ProviderError("context_overflow", "still too long") }));
    const outcome = await finish(built.kernel.run(built.log, "q"));
    expect(outcome.result.reason).toBe("error");
  });

  it("reports the overflow when compaction is off", async () => {
    const built = setup({ script: [{ error: new ProviderError("context_overflow", "too long") }], compaction: false });
    expect((await finish(built.kernel.run(built.log, "q"))).result).toMatchObject({ reason: "error" });
  });

  it("reports the overflow when there is nothing to compact", async () => {
    const built = setup({ script: [{ error: new ProviderError("context_overflow", "too long") }] });
    expect((await finish(built.kernel.run(built.log, "q"))).result).toMatchObject({ reason: "error", error: "too long" });
  });
});

describe("usage of the side questions", () => {
  it("the tokens a compaction summary costs are written to the log as their own entry", async () => {
    const built = setup({
      script: (request) => (isFirst(request) ? { text: "SUMMARY-FIRST", usage: { input: 11, output: 7 } } : { text: "r".repeat(600) }),
      contextWindow: 1000,
      compaction: compacting,
    });
    await converse(built, 4);
    const usage = (await entriesOf(built.log, "usage")) as unknown as Array<{ kind: string; usage: { input: number; output: number } }>;
    expect(usage.filter((entry) => entry.kind === "compaction").map((entry) => [entry.usage.input, entry.usage.output])).toContainEqual([11, 7]);
  });
});
