// The side requests (the goal check, compaction) are built like any request, apart from the thinking level, which they leave out.
import { describe, expect, it } from "vitest";
import { createKernel } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
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
});
