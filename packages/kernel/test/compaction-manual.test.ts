// Compacting on request: a person asks for it (a terminal's /compact), whatever the size of the conversation. Written from what that is meant to be:
// it happens first, before the new input; the new input is not summarised; nothing is asked of the model about it; and it never makes things worse.
import { describe, expect, it } from "vitest";
import { COMPACTION_PREFIX, ProviderError } from "../src/index.ts";
import type { LlmRequest, Plugin } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { finish, setup, textOf } from "./helpers.ts";

const lastText = (request: LlmRequest) => textOf(request.messages.at(-1)!);
const isFirst = (request: LlmRequest) => lastText(request).startsWith("You are writing a context checkpoint");
const isUpdate = (request: LlmRequest) => lastText(request).startsWith("The conversation above continues from an earlier checkpoint");
const isSummary = (request: LlmRequest) => isFirst(request) || isUpdate(request);

/** Ordinary replies echo the number of the question; summaries are recognisable. */
const script = (request: LlmRequest) => (isFirst(request) ? { text: "SUMMARY-FIRST" } : isUpdate(request) ? { text: "SUMMARY-UPDATE" } : { text: `answer to ${lastText(request).slice(0, 12)}` });
const entriesOf = async (log: { branch(): Promise<readonly { type: string }[]> }, type: string) => (await log.branch()).filter((entry) => entry.type === type);

async function talk(built: ReturnType<typeof setup>, ...questions: string[]) {
  for (const question of questions) await finish(built.kernel.run(built.log, question));
}

describe("compacting on request", () => {
  it("summarises a conversation that is far below the size at which it would compact by itself", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2", "q3");
    const { result, events } = await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(result.reason).toBe("done");
    expect(await entriesOf(built.log, "compaction")).toHaveLength(1);
    expect(events.filter((event) => event.type === "compaction")).toHaveLength(1);
    expect(built.llm.requests.filter(isSummary)).toHaveLength(1);
  });

  it("with nothing to answer, the model is asked only for the summary, and nothing else", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2");
    const before = built.llm.requests.length;
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(built.llm.requests.length - before).toBe(1);
  });

  it("with an input, the compaction comes first and the input is answered from the compacted conversation", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2", "q3");
    const before = built.llm.requests.length;
    await finish(built.kernel.run(built.log, "q4 after compaction", { compact: true }));
    const requests = built.llm.requests.slice(before);
    expect(requests).toHaveLength(2);
    expect(isSummary(requests[0]!)).toBe(true);
    expect(requests[0]!.messages.map(textOf).join("\n")).not.toContain("q4 after compaction"); // the new input is not part of what is summarised
    const answering = requests[1]!.messages.map(textOf);
    expect(answering[0]).toContain(COMPACTION_PREFIX);
    expect(answering[0]).toContain("SUMMARY-FIRST");
    expect(answering.at(-1)).toBe("q4 after compaction");
  });

  it("the part of the conversation that stays word for word is still there, in order, after the summary", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2", "q3");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    const shown = (await built.log.project()).map(textOf);
    expect(shown[0]).toContain("SUMMARY-FIRST");
    expect(shown.slice(1).join("|")).toContain("q3");
    expect(shown.indexOf(shown.find((text) => text.startsWith("answer to q3"))!)).toBeGreaterThan(shown.findIndex((text) => text === "q3"));
  });

  it("a second request summarises on top of the first summary", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2", "q3");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    await talk(built, "q4", "q5");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(await entriesOf(built.log, "compaction")).toHaveLength(2);
    expect(built.llm.requests.filter(isUpdate)).toHaveLength(1);
    expect(textOf((await built.log.project())[0]!)).toContain("SUMMARY-UPDATE");
  });

  it("there is nothing to summarise in a conversation of one message, so nothing is asked and nothing is changed", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await built.log.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "only" }], ts: 1 } });
    const before = built.llm.requests.length;
    const { result, events } = await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(built.llm.requests.length - before).toBeLessThanOrEqual(1); // the model may answer the lone question, but is not asked for a summary
    expect(built.llm.requests.filter(isSummary)).toHaveLength(0);
    expect(events.some((event) => event.type === "compaction")).toBe(false);
    expect(result.reason).toBe("done");
  });

  it("an empty conversation: no summary, no event, the run just ends", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    const { result, events } = await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(result.reason).toBe("done");
    expect(built.llm.requests).toHaveLength(0);
    expect(events.some((event) => event.type === "compaction")).toBe(false);
  });

  it("it works when automatic compaction is turned off", async () => {
    const built = setup({ script, contextWindow: 1_000_000, compaction: false });
    await talk(built, "q1", "q2", "q3");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(await entriesOf(built.log, "compaction")).toHaveLength(1);
    await talk(built, "q4"); // and the automatic kind stays off
    expect(built.llm.requests.filter(isSummary)).toHaveLength(1);
  });

  it("without the option nothing is compacted below the usual size, as before", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2", "q3");
    await finish(built.kernel.run(built.log));
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
  });

  it("with the option set to false it is the same as without it", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2");
    await finish(built.kernel.run(built.log, undefined, { compact: false }));
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
  });

  it("plugins are told afterwards, as after any compaction, so project instructions can be read again", async () => {
    const told: string[] = [];
    const plugin: Plugin = { name: "watcher", setup: () => undefined, afterCompaction: async () => void told.push("after") };
    const built = setup({ script, contextWindow: 1_000_000, plugins: [plugin] });
    await talk(built, "q1", "q2");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(told).toEqual(["after"]);
  });

  it("the pinned instructions stay in front of the summary", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await built.log.append({ type: "custom_message", customType: "agents_md", pinned: true, content: [{ type: "text", text: "Project rules" }] });
    await talk(built, "q1", "q2", "q3");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    const shown = (await built.log.project()).map(textOf);
    expect(shown[0]).toBe("Project rules");
    expect(shown[1]).toContain("SUMMARY-FIRST");
  });

  it("a summary that fails does not end the run or change the conversation, and the person can see it did not work", async () => {
    let calls = 0;
    const built = setup({
      script: (request) => {
        if (isFirst(request)) {
          calls++;
          return { error: new ProviderError("other", "summary service down") };
        }
        return { text: "answer" };
      },
      contextWindow: 1_000_000,
    });
    await talk(built, "q1", "q2", "q3");
    const before = (await built.log.branch()).length;
    const { result, events } = await finish(built.kernel.run(built.log, "q4", { compact: true }));
    expect(result.reason).toBe("done"); // q4 is still answered
    expect(calls).toBeGreaterThan(0);
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
    expect(events.some((event) => event.type === "plugin" && (event.data as { error?: string }).error?.includes("summary service down"))).toBe(true);
    expect((await built.log.branch()).length).toBeGreaterThan(before);
  });

  it("an empty summary is not written", async () => {
    const built = setup({ script: (request) => (isFirst(request) ? { text: "   " } : { text: "answer" }), contextWindow: 1_000_000 });
    await talk(built, "q1", "q2");
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
  });

  it("cancelling during the compaction ends the run as cancelled", async () => {
    const built = setup({ script: (request) => (isFirst(request) ? { hang: true } : { text: "answer" }), contextWindow: 1_000_000 });
    await talk(built, "q1", "q2");
    const handle = built.kernel.run(built.log, undefined, { compact: true });
    setTimeout(() => handle.cancel(), 50);
    for await (const _event of handle.events) void _event;
    expect((await handle.result).reason).toBe("cancelled");
    expect(await entriesOf(built.log, "compaction")).toHaveLength(0);
  });

  it("it does not start a second run on a conversation that is already being worked on", async () => {
    const built = setup({ script: () => ({ text: "answer" }), contextWindow: 1_000_000 });
    const log = createMemoryLog();
    const first = built.kernel.run(log, "q1");
    expect(() => built.kernel.run(log, undefined, { compact: true })).toThrow("already has an active run");
    for await (const _event of first.events) void _event;
  });

  it("a conversation that ends with a question the model has not answered is answered after the compaction", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2");
    await built.log.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "q3 left open" }], ts: 1 } });
    const before = built.llm.requests.length;
    await finish(built.kernel.run(built.log, undefined, { compact: true }));
    const requests = built.llm.requests.slice(before);
    expect(isSummary(requests[0]!)).toBe(true);
    expect(textOf(requests.at(-1)!.messages.at(-1)!)).toBe("q3 left open");
  });

  it("compacting does not use up the turn: the usual size check is not run twice in the one run", async () => {
    const built = setup({ script, contextWindow: 1_000_000 });
    await talk(built, "q1", "q2", "q3");
    await finish(built.kernel.run(built.log, "q4", { compact: true }));
    expect(built.llm.requests.filter(isSummary)).toHaveLength(1);
  });
});

describe("cancelling while the conversation is being summarised", () => {
  it("also when the compaction was not asked for but came by itself", async () => {
    let hang = false;
    const built = setup({
      script: (request) => (isFirst(request) ? (hang ? { hang: true } : { text: "SUMMARY" }) : { text: "x".repeat(100) }),
      contextWindow: 1000,
      compaction: { reserveTokens: 200, keepRecentTokens: 150 },
    });
    await talk(built, "a".repeat(400), "b".repeat(400));
    hang = true;
    const handle = built.kernel.run(built.log, "e".repeat(3200)); // too big to be answered without a summary first
    setTimeout(() => handle.cancel(), 100);
    for await (const _event of handle.events) void _event;
    expect((await handle.result).reason).toBe("cancelled");
    expect(built.llm.requests.some(isFirst)).toBe(true); // it was summarising when it was stopped
  });

  it("a failure that is not a cancel is still an error", async () => {
    const built = setup({ script: () => ({ text: "ok" }), contextWindow: 1_000_000 });
    await talk(built, "q1", "q2");
    const broken: Plugin = {
      name: "broken",
      setup: () => undefined,
      prepare: async () => {
        throw new Error("a plugin failed to prepare");
      },
    };
    const again = setup({ script: () => ({ text: "ok" }), contextWindow: 1_000_000, plugins: [broken] });
    const { result } = await finish(again.kernel.run(again.log, "q"));
    expect(result.reason).toBe("error");
    expect(result.error).toContain("a plugin failed to prepare");
  });
});
