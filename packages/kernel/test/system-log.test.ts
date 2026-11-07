import { describe, expect, it } from "vitest";
import { createMemoryLog } from "@sakura/session";
import type { LogEntry } from "../src/index.ts";
import { replaySystem } from "../src/system.ts";
import { echo, finish, setup, textOf } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const patches = async (log: { branch(): Promise<readonly LogEntry[]> }) => (await log.branch()).filter((entry) => entry.type === "system_patch");

describe("the system prompt and tools are recorded in the log", () => {
  it("the first run writes one full patch before the first message", async () => {
    const built = setup({ script: [{ text: "hi" }], tools: [echo("a"), echo("b")] });
    await finish(built.kernel.run(built.log, "go"));
    const branch = await built.log.branch();
    expect(branch[0]).toMatchObject({ type: "system_patch", sections: { system: "system prompt" } });
    expect((branch[0] as { toolsAdded: Array<{ name: string }> }).toolsAdded.map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(await patches(built.log)).toHaveLength(1);
  });

  for (const runs of range(5, 1)) {
    it(`${runs} runs with the same configuration write only one patch`, async () => {
      const built = setup({ script: Array.from({ length: runs }, () => ({ text: "x" })), tools: [echo("a")] });
      for (let index = 0; index < runs; index++) await finish(built.kernel.run(built.log, `q${index}`));
      expect(await patches(built.log)).toHaveLength(1);
    });
  }

  it("the request uses what the log says", async () => {
    const built = setup({ script: [{ text: "x" }], tools: [echo("a")] });
    await finish(built.kernel.run(built.log, "go"));
    const state = replaySystem(await built.log.branch());
    expect(built.llm.requests[0]!.system).toBe(state.sections.system);
    expect(built.llm.requests[0]!.tools.map((tool) => tool.name)).toEqual(state.tools.map((tool) => tool.name));
  });

  it("a tool that the configuration lost stays declared, and calling it gives a tool error", async () => {
    const log = createMemoryLog();
    const first = setup({ script: [{ text: "x" }], tools: [echo("keep"), echo("gone")], log });
    await finish(first.kernel.run(log, "one"));
    const second = setup({ script: [{ toolCalls: [{ name: "gone", args: {}, id: "c" }] }, { text: "ok" }], tools: [echo("keep")], log });
    await finish(second.kernel.run(log, "two"));
    expect(second.llm.requests[0]!.tools.map((tool) => tool.name)).toEqual(["keep", "gone"]);
    const answer = (await log.project()).find((message) => message.role === "tool")!;
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("not available");
  });

  it("a new tool is added at the end and recorded in a second patch", async () => {
    const log = createMemoryLog();
    await finish(setup({ script: [{ text: "x" }], tools: [echo("a")], log }).kernel.run(log, "one"));
    const second = setup({ script: [{ text: "y" }], tools: [echo("a"), echo("b")], log });
    await finish(second.kernel.run(log, "two"));
    expect(second.llm.requests[0]!.tools.map((tool) => tool.name)).toEqual(["a", "b"]);
    const all = await patches(log);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ toolsAdded: [{ name: "b" }] });
    expect((all[1] as { sections?: unknown }).sections).toBeUndefined();
  });

  it("a changed system prompt is a section patch only", async () => {
    const log = createMemoryLog();
    await finish(setup({ script: [{ text: "x" }], log }).kernel.run(log, "one"));
    const { createKernel } = await import("../src/index.ts");
    const { createFauxClient } = await import("@sakura/testing");
    const { env } = await import("./helpers.ts");
    const llm = createFauxClient([{ text: "y" }]);
    const kernel = createKernel({ llm, env, system: "a different prompt", compaction: false, now: () => 1 });
    const handle = kernel.run(log, "two");
    for await (const _event of handle.events) void _event;
    expect(llm.requests[0]!.system).toBe("a different prompt");
    expect((await patches(log)).at(-1)).toMatchObject({ sections: { system: "a different prompt" } });
  });

  it("a changed tool declaration is written as remove and add", async () => {
    const log = createMemoryLog();
    await finish(setup({ script: [{ text: "x" }], tools: [echo("a", { description: "old" })], log }).kernel.run(log, "one"));
    await finish(setup({ script: [{ text: "y" }], tools: [echo("a", { description: "new" })], log }).kernel.run(log, "two"));
    expect((await patches(log)).at(-1)).toMatchObject({ toolsRemoved: ["a"], toolsAdded: [{ name: "a", description: "new" }] });
  });

  it("patches do not reach the model as messages", async () => {
    const built = setup({ script: [{ text: "x" }], tools: [echo("a")] });
    await finish(built.kernel.run(built.log, "go"));
    expect(built.llm.requests[0]!.messages.map(textOf)).toEqual(["go"]);
  });

  it("compaction keeps the system state", async () => {
    const built = setup({
      script: (request) => ({ text: textOf(request.messages.at(-1)!).startsWith("You are writing") ? "SUMMARY" : "r".repeat(500) }),
      contextWindow: 1000,
      compaction: { reserveTokens: 200, keepRecentTokens: 150 },
      tools: [echo("a")],
    });
    for (let turn = 0; turn < 6; turn++) await finish(built.kernel.run(built.log, `${turn}:${"u".repeat(400)}`));
    expect((await built.log.branch()).some((entry) => entry.type === "compaction")).toBe(true);
    expect(built.llm.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(["a"]);
    expect(built.llm.requests.at(-1)!.system).toBe("system prompt");
  });

  it("works with a log that was written before this feature existed", async () => {
    const log = createMemoryLog();
    await log.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "old question" }], ts: 1 } });
    await log.append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old answer" }], ts: 1 } });
    const built = setup({ script: [{ text: "new answer" }], tools: [echo("a")], log });
    await finish(built.kernel.run(log, "new question"));
    expect(built.llm.requests[0]!.system).toBe("system prompt");
    expect((await log.project()).map(textOf)).toEqual(["old question", "old answer", "new question", "new answer"]);
  });

  it("the system state follows the branch: rewinding to before a patch removes its effect", async () => {
    const log = createMemoryLog();
    await finish(setup({ script: [{ text: "x" }], tools: [echo("a")], log }).kernel.run(log, "one"));
    const mark = await log.append({ type: "custom", customType: "mark", data: 1 });
    await finish(setup({ script: [{ text: "y" }], tools: [echo("a"), echo("b")], log }).kernel.run(log, "two"));
    log.rewindTo(mark.id);
    expect(replaySystem(await log.branch()).tools.map((tool) => tool.name)).toEqual(["a"]);
  });
});
