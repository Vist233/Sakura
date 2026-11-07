import { describe, expect, it } from "vitest";
import { finish, runOnce, textOf } from "./helpers.ts";

describe("a restart event inside a reply", () => {
  for (const partial of ["a", "partial text that was cut", "x".repeat(200)]) {
    it(`throws away the partial reply (${partial.length} characters) and keeps only the whole one`, async () => {
      const { log, events } = await runOnce({ script: [{ droppedFirst: partial, text: "the whole reply" }] });
      expect(textOf((await log.project())[1]!)).toBe("the whole reply");
      expect(events.filter((event) => event.type === "message_reset")).toHaveLength(1);
    });
  }

  it("the reset comes after the partial updates and before the final message", async () => {
    const { events } = await runOnce({ script: [{ droppedFirst: "par", text: "whole" }] });
    const types = events.map((event) => event.type);
    expect(types.indexOf("message_update")).toBeLessThan(types.indexOf("message_reset"));
    expect(types.indexOf("message_reset")).toBeLessThan(types.lastIndexOf("message_end"));
  });

  it("usage from the dropped try does not count", async () => {
    const { log } = await runOnce({ script: [{ droppedFirst: "par", text: "whole", usage: { input: 5, output: 7 } }] });
    expect((await log.project())[1]!.usage).toMatchObject({ input: 5, output: 7 });
  });

  it("tool calls after a restart run once", async () => {
    let runs = 0;
    const tool = {
      name: "t",
      description: "",
      parameters: {},
      effect: "read" as const,
      execute: async () => {
        runs++;
        return { content: [] };
      },
    };
    await runOnce({ script: [{ droppedFirst: "par", toolCalls: [{ name: "t", args: {}, id: "c" }] }, { text: "done" }], tools: [tool] });
    expect(runs).toBe(1);
  });

  it("a restart inside a side request (compaction) discards the partial summary", async () => {
    const built = (await import("./helpers.ts")).setup({
      script: (request) => (textOf(request.messages.at(-1)!).startsWith("You are writing") ? { droppedFirst: "PARTIAL SUMMARY", text: "FULL SUMMARY" } : { text: "r".repeat(500) }),
      contextWindow: 1000,
      compaction: { reserveTokens: 200, keepRecentTokens: 150 },
    });
    for (let turn = 0; turn < 6; turn++) await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`));
    const compaction = (await built.log.branch()).find((entry) => entry.type === "compaction");
    expect(compaction && compaction.type === "compaction" && compaction.summary).toBe("FULL SUMMARY");
  });
});
