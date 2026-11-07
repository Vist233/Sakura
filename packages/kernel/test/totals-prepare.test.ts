import { describe, expect, it } from "vitest";
import type { Plugin, TurnInfo } from "../src/index.ts";
import { createRng } from "@sakura/testing";
import { finish, setup, textOf } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);

describe("usage totals in turn.end", () => {
  for (const seed of range(30)) {
    it(`sums the usage of every reply in the session (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const replies = Array.from({ length: rng.int(1, 6) }, () => ({ input: rng.int(1, 500), output: rng.int(1, 200), cacheRead: rng.int(0, 100) }));
      const seen: TurnInfo[] = [];
      const p: Plugin = { name: "watch", setup: (api) => api.on("turn.end", (turn) => void seen.push(turn)) };
      const built = setup({ script: replies.map((usage) => ({ text: "x", usage })), plugins: [p] });
      for (let index = 0; index < replies.length; index++) await finish(built.kernel.run(built.log, `q${index}`));
      const last = seen.at(-1)!;
      expect(last.totals.turns).toBe(replies.length);
      expect(last.totals.input).toBe(replies.reduce((sum, usage) => sum + usage.input, 0));
      expect(last.totals.output).toBe(replies.reduce((sum, usage) => sum + usage.output, 0));
      expect(last.totals.cacheRead).toBe(replies.reduce((sum, usage) => sum + usage.cacheRead, 0));
      expect(seen.map((turn) => turn.totals.turns)).toEqual(range(replies.length));
    });
  }

  it("counts usage entries that are not part of the conversation", async () => {
    const seen: TurnInfo[] = [];
    const p: Plugin = { name: "watch", setup: (api) => api.on("turn.end", (turn) => void seen.push(turn)) };
    const built = setup({ script: [{ text: "x", usage: { input: 10, output: 5 } }], plugins: [p] });
    await built.log.append({ type: "usage", kind: "other", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } });
    await finish(built.kernel.run(built.log, "q"));
    expect(seen[0]?.totals).toMatchObject({ input: 110, output: 55, turns: 1 });
  });

  it("keeps counting after a restart because it is read from the log", async () => {
    const seen: TurnInfo[] = [];
    const p: Plugin = { name: "watch", setup: (api) => api.on("turn.end", (turn) => void seen.push(turn)) };
    const first = setup({ script: [{ text: "x", usage: { input: 7, output: 1 } }], plugins: [p] });
    await finish(first.kernel.run(first.log, "q"));
    const second = setup({ script: [{ text: "y", usage: { input: 8, output: 1 } }], plugins: [p], log: first.log });
    await finish(second.kernel.run(second.log, "q2"));
    expect(seen.at(-1)?.totals).toMatchObject({ input: 15, turns: 2 });
  });
});

describe("plugin prepare", () => {
  for (const runs of range(5)) {
    it(`is called at the start of every run (${runs} runs)`, async () => {
      let calls = 0;
      const p: Plugin = { name: "p", setup: () => undefined, prepare: async () => void calls++ };
      const built = setup({ script: Array.from({ length: runs }, () => ({ text: "x" })), plugins: [p] });
      for (let index = 0; index < runs; index++) await finish(built.kernel.run(built.log, `q${index}`));
      expect(calls).toBe(runs);
    });
  }

  it("can add pinned context to the log once", async () => {
    const p: Plugin = {
      name: "rules",
      setup: () => undefined,
      prepare: async ({ log }) => {
        if ((await log.branch()).some((entry) => entry.type === "custom_message" && entry.customType === "rules")) return;
        await log.append({ type: "custom_message", customType: "rules", pinned: true, content: [{ type: "text", text: "RULES" }] });
      },
    };
    const built = setup({ script: [{ text: "a" }, { text: "b" }], plugins: [p] });
    await finish(built.kernel.run(built.log, "one"));
    await finish(built.kernel.run(built.log, "two"));
    expect((await built.log.branch()).filter((entry) => entry.type === "custom_message")).toHaveLength(1);
    expect(textOf(built.llm.requests[1]!.messages[0]!)).toBe("RULES");
  });

  it("runs in plugin order, before the model is asked", async () => {
    const order: string[] = [];
    const mk = (name: string): Plugin => ({ name, setup: () => undefined, prepare: async () => void order.push(name) });
    const built = setup({ script: [{ text: "x" }], plugins: [mk("a"), mk("b")] });
    await finish(built.kernel.run(built.log, "go"));
    expect(order).toEqual(["a", "b"]);
  });

  it("a failing prepare ends the run with an error and frees the log", async () => {
    const p: Plugin = {
      name: "bad",
      setup: () => undefined,
      prepare: async () => {
        throw new Error("cannot prepare");
      },
    };
    const built = setup({ script: [{ text: "x" }], plugins: [p] });
    const outcome = await finish(built.kernel.run(built.log, "go"));
    expect(outcome.result).toEqual({ reason: "error", error: "cannot prepare" });
    expect(() => built.kernel.run(built.log, "again")).not.toThrow();
  });
});
