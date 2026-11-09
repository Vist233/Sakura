import { describe, expect, it } from "vitest";
import { delay, finish, setup, text, textOf, tool } from "./helpers.ts";

// A goal belongs to the session, so setting and clearing one writes to the log, the same entries a goal from the configuration writes.
const check = (answer: string) => ({ text: answer });

describe("kernel.goal / setGoal / clearGoal", () => {
  it("there is no goal before one is set", async () => {
    const built = setup({ script: [] });
    expect(await built.kernel.goal(built.log)).toBeUndefined();
  });

  it("setGoal writes an active goal and tells the model, pinned", async () => {
    const built = setup({ script: [] });
    await built.kernel.setGoal(built.log, { objective: "ship it", verify: "true" });
    expect(await built.kernel.goal(built.log)).toEqual({ objective: "ship it", verify: "true", status: "active", humanStreak: 0 });
    const entries = await built.log.branch();
    expect(entries.at(-1)).toMatchObject({ type: "custom_message", customType: "goal", pinned: true });
    expect(textOf((await built.log.project()).at(-1)!)).toContain("ship it");
  });

  it("a goal set this way is checked before the run may stop", async () => {
    const built = setup({ script: [{ text: "finished" }, check("- [done] x :: y")] });
    await built.kernel.setGoal(built.log, { objective: "ship it" });
    const { result } = await finish(built.kernel.run(built.log, "go"));
    expect(result.reason).toBe("done");
    expect((await built.kernel.goal(built.log))?.status).toBe("complete");
    expect(built.llm.requests).toHaveLength(2);
  });

  it("a second setGoal replaces the first, and the model is no longer told about the old one", async () => {
    const built = setup({ script: [] });
    await built.kernel.setGoal(built.log, { objective: "first aim" });
    await built.kernel.setGoal(built.log, { objective: "second aim" });
    expect((await built.kernel.goal(built.log))?.objective).toBe("second aim");
    const seen = (await built.log.project()).map(textOf).join("\n");
    expect(seen).toContain("second aim");
    expect(seen).not.toContain("first aim");
  });

  it("clearGoal ends the goal and takes it out of the context", async () => {
    const built = setup({ script: [{ text: "hello" }] });
    await built.kernel.setGoal(built.log, { objective: "ship it" });
    await built.kernel.clearGoal(built.log);
    expect((await built.kernel.goal(built.log))?.status).toBe("complete");
    expect((await built.log.project()).map(textOf).join("\n")).not.toContain("ship it");
    const { result } = await finish(built.kernel.run(built.log, "hi"));
    expect(result.reason).toBe("done");
    expect(built.llm.requests).toHaveLength(1); // no check before stopping
  });

  it("clearGoal with no goal does nothing", async () => {
    const built = setup({ script: [] });
    await built.kernel.clearGoal(built.log);
    expect(await built.log.branch()).toHaveLength(0);
  });

  it("a goal from the configuration does not come back after it was cleared", async () => {
    const built = setup({ script: [{ text: "hello" }], goal: { objective: "configured aim" } });
    await finish(built.kernel.run(built.log, "hi")); // opens the configured goal (its check answers by the script running out)
    await built.kernel.clearGoal(built.log);
    const before = (await built.log.branch()).length;
    const again = setup({ script: [{ text: "hello again" }], goal: { objective: "configured aim" }, log: built.log });
    await finish(again.kernel.run(again.log, "hi again"));
    const added = (await built.log.branch()).slice(before);
    expect(added.some((entry) => entry.type === "goal")).toBe(false);
  });

  it("refuses to change the goal while a run is going on", async () => {
    const slow = tool("slow", async () => {
      await delay(100);
      return { content: text("ok") };
    });
    const built = setup({ script: [{ toolCalls: [{ name: "slow", args: {}, id: "s" }] }, { text: "done" }], tools: [slow] });
    const handle = built.kernel.run(built.log, "go");
    await delay(20);
    await expect(built.kernel.setGoal(built.log, { objective: "late" })).rejects.toThrow(/active run/);
    await expect(built.kernel.clearGoal(built.log)).rejects.toThrow(/active run/);
    await finish(handle);
  });
});
