import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, Message } from "@sakura/kernel";
import { limitsPlugin } from "@sakura/plugin-limits";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import { runSecondsFor, UNATTENDED_RULES, unattendedGoal, unattendedPlugin } from "../src/index.ts";

const env = { cwd: "/", resolve: (path: string) => path, dispose: async () => undefined } as unknown as Environment;
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const finish = async (handle: ReturnType<ReturnType<typeof createKernel>["run"]>) => {
  for await (const _event of handle.events) void _event;
  return handle.result;
};

describe("runSecondsFor", () => {
  it("keeps a margin for the final answer, never more than a fifth of the time", () => {
    expect(runSecondsFor(3600)).toBe(3540);
    expect(runSecondsFor(100)).toBe(80);
    expect(runSecondsFor(3600, 300)).toBe(3300);
    expect(runSecondsFor(10)).toBe(8);
  });
});

describe("the rules", () => {
  it("are given to the model once, as a pinned message, and again never (a second run, a restarted session)", async () => {
    const llm = createFauxClient([{ text: "a" }, { text: "b" }]);
    const kernel = createKernel({ llm, env, system: "s", plugins: [unattendedPlugin()], compaction: false });
    const log = createMemoryLog();
    await finish(kernel.run(log, "first"));
    await finish(kernel.run(log, "second"));
    const stored = (await log.branch()).filter((entry) => entry.type === "custom_message" && entry.customType === "unattended_rules");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ pinned: true });
    expect(llm.requests[0]!.messages.map(textOf).join("\n")).toContain("running unattended");
  });

  it("can be replaced", async () => {
    const llm = createFauxClient([{ text: "a" }]);
    const kernel = createKernel({ llm, env, system: "s", plugins: [unattendedPlugin({ rules: "Be quick." })], compaction: false });
    await finish(kernel.run(createMemoryLog(), "go"));
    const seen = llm.requests[0]!.messages.map(textOf).join("\n");
    expect(seen).toContain("Be quick.");
    expect(seen).not.toContain("running unattended");
  });

  it("tell the model to check each requirement with a command, not to ask, not to stop at a plan", () => {
    expect(UNATTENDED_RULES).toContain("Do not stop at a plan and do not ask questions");
    expect(UNATTENDED_RULES).toContain("check each one with a command");
  });
});

describe("the time limit", () => {
  it("goes to the limits plugin with the margin taken off", () => {
    const limits = limitsPlugin();
    const seen: number[] = [];
    unattendedPlugin({ timeLimitSeconds: 1800, limits: { update: (budget) => void seen.push(budget.maxRunSeconds) } }).setup({
      on: () => undefined,
      registerTool: () => undefined,
      emit: () => undefined,
    });
    expect(seen).toEqual([1740]);
    expect(limits.name).toBe("limits");
  });

  it("makes the run pause at the limit, and the model is told how much time it has", async () => {
    let clock = 0;
    const limits = limitsPlugin({ now: () => clock });
    const plugin = unattendedPlugin({ timeLimitSeconds: 110, marginSeconds: 10, limits });
    const tick = {
      name: "tick",
      description: "",
      parameters: { type: "object" as const, properties: {} },
      effect: "read" as const,
      async execute() {
        clock += 40_000;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };
    const script = Array.from({ length: 5 }, (_, index) => ({ toolCalls: [{ name: "tick", args: {}, id: `t${index}` }] }));
    const llm = createFauxClient(script);
    const kernel = createKernel({ llm, env, system: "s", plugins: [limits, plugin], tools: [tick], compaction: false, now: () => clock });
    const result = await finish(kernel.run(createMemoryLog(), "go"));
    expect(result).toMatchObject({ reason: "paused", pause: "budget" });
    expect(llm.requests).toHaveLength(3); // 40 s, 80 s, 120 s: the limit is 100 s
    expect(textOf(llm.requests[2]!.messages.at(-1)!)).toContain("1.3 of 1.7 minutes used");
    expect(textOf(llm.requests[2]!.messages.at(-1)!)).toContain("close to a limit");
  });
});

describe("the final check", () => {
  it("unattendedGoal states the task and what complete means, and passes verify on", () => {
    const goal = unattendedGoal("  build the thing \n", "test -f out.txt");
    expect(goal.objective).toBe("Complete this task:\n\nbuild the thing\n\nIt is complete only when every requirement in it holds and you have checked each one with a command.");
    expect(goal.verify).toBe("test -f out.txt");
    expect("verify" in unattendedGoal("x")).toBe(false);
  });

  it("the kernel checks the requirements before the run may end, and a requirement that is not done sends the model back to work", async () => {
    const llm = createFauxClient([
      { text: "I think I am done." },
      { text: "- [todo] the output file exists :: not checked" }, // the check the kernel asks for
      { text: "I created and checked the file." },
      { text: "- [done] the output file exists :: ls shows it" },
    ]);
    const kernel = createKernel({ llm, env, system: "s", plugins: [unattendedPlugin()], compaction: false, goal: unattendedGoal("make out.txt") });
    const log = createMemoryLog();
    const result = await finish(kernel.run(log, "make out.txt"));
    expect(result.reason).toBe("done");
    expect(llm.requests).toHaveLength(4);
    expect(llm.requests[1]!.messages.map(textOf).join("\n")).toContain("You are about to stop. Check your work against the goal");
    expect(llm.requests[1]!.messages.map(textOf).join("\n")).toContain("make out.txt");
    expect(llm.requests[2]!.messages.map(textOf).join("\n")).toContain("the output file exists");
  });
});
