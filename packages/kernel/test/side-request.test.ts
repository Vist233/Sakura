// The side requests (the goal check, compaction) are built like any request, apart from the thinking level and the `context` hook, which they leave out
// (what a plugin adds to the agent's view would land after their question). The `request` hook sees every request.
import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import type { Message, Plugin } from "../src/index.ts";
import { env, finish } from "./helpers.ts";

describe("side requests", () => {
  it("the goal check has the same system and tools as the run, no thinking level, and the hooks' view of the messages", async () => {
    const llm = createFauxClient([{ text: "done?" }, { text: "- [done] x :: y" }]);
    const kernel = createKernel({ llm, env, system: "sys", thinking: "high", maxTokens: 99, compaction: false, goal: { objective: "x" } });
    await finish(kernel.run(createMemoryLog(), "go"));
    const [main, check] = llm.requests;
    expect(main).toMatchObject({ system: "sys", thinking: "high", maxTokens: 99 });
    expect(check?.system).toBe(main?.system);
    expect(check?.tools).toEqual(main?.tools);
    expect(check?.maxTokens).toBe(99);
    expect("thinking" in (check ?? {})).toBe(false);
  });

  it("the context hook shapes the agent's turns only: the goal check and the compaction summary end with their own question; the request hook sees all", async () => {
    const note = (): Message => ({ role: "user", content: [{ type: "text", text: "[note from a plugin]" }], ts: 0 });
    const seenByRequest: number[] = [];
    const plugin: Plugin = {
      name: "notes",
      setup(api) {
        api.on("context", ({ messages }) => [...messages, note()]);
        api.on("request", (request) => void seenByRequest.push(request.messages.length));
      },
    };
    const llm = createFauxClient([{ text: "done?" }, { text: "- [done] x :: y" }, { text: "a summary" }]);
    const kernel = createKernel({ llm, env, system: "sys", plugins: [plugin], compaction: { keepRecentTokens: 1 }, goal: { objective: "x" } });
    const log = createMemoryLog();
    await finish(kernel.run(log, "go"));
    await finish(kernel.run(log, undefined, { compact: true }));
    const lastText = (index: number) => JSON.stringify(llm.requests[index]?.messages.at(-1)?.content);
    expect(lastText(0)).toContain("[note from a plugin]"); // the agent's turn
    expect(lastText(1)).not.toContain("[note from a plugin]"); // the goal check ends with its question
    expect(llm.requests.length).toBeGreaterThanOrEqual(3);
    expect(lastText(llm.requests.length - 1)).not.toContain("[note from a plugin]"); // the compaction summary too
    expect(seenByRequest).toHaveLength(llm.requests.length);
  });
});
