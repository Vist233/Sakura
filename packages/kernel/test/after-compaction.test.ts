import { describe, expect, it } from "vitest";
import type { Plugin } from "../src/index.ts";
import { finish, setup, textOf } from "./helpers.ts";

const summarising = (request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => ({
  text: (request.messages.at(-1)?.content[0]?.text ?? "").startsWith("You are writing") ? "SUMMARY" : "r".repeat(500),
});
const compact = { reserveTokens: 200, keepRecentTokens: 150 };

describe("afterCompaction", () => {
  it("is called once per compaction, with the log and the environment, after the compaction is written", async () => {
    const calls: Array<{ cwd: string; compactionWritten: boolean }> = [];
    const p: Plugin = {
      name: "p",
      setup: () => undefined,
      afterCompaction: async ({ log, env }) => {
        calls.push({ cwd: env.cwd, compactionWritten: (await log.branch()).some((entry) => entry.type === "compaction") });
      },
    };
    const built = setup({ script: summarising as never, contextWindow: 1000, compaction: compact, plugins: [p] });
    for (let turn = 0; turn < 8; turn++) await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`));
    const compactions = (await built.log.branch()).filter((entry) => entry.type === "compaction").length;
    expect(compactions).toBeGreaterThan(0);
    expect(calls).toHaveLength(compactions);
    expect(calls.every((call) => call.compactionWritten && call.cwd === "/work")).toBe(true);
  });

  it("is not called when nothing was compacted", async () => {
    let called = 0;
    const p: Plugin = { name: "p", setup: () => undefined, afterCompaction: async () => void called++ };
    const built = setup({ script: [{ text: "a" }, { text: "b" }], plugins: [p] });
    await finish(built.kernel.run(built.log, "one"));
    await finish(built.kernel.run(built.log, "two"));
    expect(called).toBe(0);
  });

  it("a plugin that fails is reported and the run carries on", async () => {
    const p: Plugin = {
      name: "bad",
      setup: () => undefined,
      afterCompaction: async () => {
        throw new Error("refresh failed");
      },
    };
    const built = setup({ script: summarising as never, contextWindow: 1000, compaction: compact, plugins: [p] });
    const seen: string[] = [];
    for (let turn = 0; turn < 8; turn++) {
      const outcome = await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`));
      expect(outcome.result.reason).toBe("done");
      seen.push(...outcome.events.flatMap((event) => (event.type === "plugin" && event.name === "bad" ? [JSON.stringify(event.data)] : [])));
    }
    expect(seen.some((item) => item.includes("afterCompaction"))).toBe(true);
  });

  it("what the plugin adds is visible to the next request", async () => {
    const p: Plugin = {
      name: "p",
      setup: () => undefined,
      afterCompaction: async ({ log }) => void (await log.append({ type: "custom_message", customType: "x", pinned: true, content: [{ type: "text", text: "REFRESHED" }] })),
    };
    const built = setup({ script: summarising as never, contextWindow: 1000, compaction: compact, plugins: [p] });
    for (let turn = 0; turn < 8; turn++) await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`));
    const normal = built.llm.requests.filter((request) => !textOf(request.messages.at(-1)!).startsWith("You are writing")).at(-1)!;
    expect(normal.messages.map(textOf)).toContain("REFRESHED");
  });
});
