import { describe, expect, it } from "vitest";
import { BLOCKED_AFTER, describeRemaining, judgeChecklist, parseChecklist } from "../src/goal.ts";
import type { LlmRequest } from "../src/index.ts";
import { createRng } from "@sakura/testing";
import { finish, scriptedEnv, setup, textOf } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const lastText = (request: LlmRequest) => textOf(request.messages.at(-1)!);
const isCheck = (request: LlmRequest) => lastText(request).startsWith("You are about to stop.");

describe("parseChecklist", () => {
  const cases: Array<[string, string, string, string]> = [
    ["- [done] write the file :: file.txt exists", "done", "write the file", "file.txt exists"],
    ["* [todo] run the tests :: not run yet", "todo", "run the tests", "not run yet"],
    ["[human] approve the deploy :: needs the owner", "human", "approve the deploy", "needs the owner"],
    ["  - [DONE] upper case status :: ok", "done", "upper case status", "ok"],
    ["- [todo] no note here", "todo", "no note here", ""],
    ["- [done]    extra   spaces  ::   evidence  ", "done", "extra   spaces", "evidence"],
  ];
  for (const [line, status, text, note] of cases) {
    for (const variant of range(4)) {
      it(`reads "${line.trim().slice(0, 40)}" (variant ${variant})`, () => {
        const items = parseChecklist(`intro text\n${line}\ntrailing prose ${variant}`);
        expect(items).toEqual([{ status, text, note }]);
      });
    }
  }
  it("ignores lines that do not follow the format", () => {
    expect(parseChecklist("- [maybe] x\n- done y\n[ ] z\nplain")).toEqual([]);
  });
  for (const seed of range(20, 100)) {
    it(`reads many items in order (seed ${seed})`, () => {
      const rng = createRng(seed);
      const statuses = Array.from({ length: rng.int(1, 12) }, () => rng.pick(["done", "todo", "human"] as const));
      const text = statuses.map((status, index) => `- [${status}] item ${index} :: note ${index}`).join("\n");
      expect(parseChecklist(text).map((item) => item.status)).toEqual(statuses);
    });
  }
});

describe("judgeChecklist", () => {
  const item = (status: "done" | "todo" | "human") => ({ status, text: status, note: "" });
  const table: Array<[string, Array<"done" | "todo" | "human">, string]> = [
    ["all done", ["done", "done"], "complete"],
    ["one done", ["done"], "complete"],
    ["a todo", ["done", "todo"], "continue"],
    ["only todo", ["todo"], "continue"],
    ["human only", ["human"], "needs_human"],
    ["done and human", ["done", "human"], "needs_human"],
    ["todo beats human", ["human", "todo", "done"], "continue"],
  ];
  for (const [name, statuses, kind] of table) {
    for (const variant of range(3)) {
      it(`${name} is ${kind} (variant ${variant})`, () => {
        expect(judgeChecklist(statuses.map(item)).kind).toBe(kind);
      });
    }
  }
  it("an empty checklist can never complete the goal", () => {
    const verdict = judgeChecklist([]);
    expect(verdict.kind).toBe("continue");
  });
  it("describes remaining items with their notes", () => {
    expect(
      describeRemaining([
        { status: "todo", text: "a", note: "n" },
        { status: "todo", text: "b", note: "" },
      ]),
    ).toBe("- a (n)\n- b");
  });
  it("blocks after three consecutive human verdicts", () => {
    expect(BLOCKED_AFTER).toBe(3);
  });
});

/** Normal replies finish the task; the goal check answers come from `checks` in order. */
function withChecks(checks: string[]) {
  let index = 0;
  return (request: LlmRequest) => (isCheck(request) ? { text: checks[Math.min(index++, checks.length - 1)] ?? "" } : { text: "I think I am done." });
}
const goal = { objective: "make the thing work" };
const entriesOf = async (log: { branch(): Promise<readonly { type: string }[]> }, type: string) => (await log.branch()).filter((entry) => entry.type === type);
const goalStatus = async (log: Parameters<typeof entriesOf>[0]) => ((await entriesOf(log, "goal")).at(-1) as unknown as { goal: { status: string; humanStreak: number } }).goal;

describe("goal in a run", () => {
  it("opens the goal and tells the model about it, pinned", async () => {
    const built = setup({ script: withChecks(["- [done] x :: y"]), goal });
    await finish(built.kernel.run(built.log, "start"));
    const entries = await built.log.branch();
    expect(entries[1]).toMatchObject({ type: "goal", goal: { objective: "make the thing work", status: "active" } });
    expect(entries[2]).toMatchObject({ type: "custom_message", customType: "goal", pinned: true });
    expect(textOf((await built.log.project())[0]!)).toContain("make the thing work");
  });

  it("does not open a second goal when the log is run again", async () => {
    const built = setup({ script: withChecks(["- [done] x :: y"]), goal });
    await finish(built.kernel.run(built.log, "one"));
    await finish(built.kernel.run(built.log, "two"));
    expect((await entriesOf(built.log, "goal")).filter((entry) => (entry as unknown as { goal: { status: string } }).goal.status === "active")).toHaveLength(1);
  });

  for (const seed of range(20)) {
    it(`completes when every item is done (seed ${seed})`, async () => {
      const count = createRng(seed).int(1, 6);
      const check = Array.from({ length: count }, (_, index) => `- [done] item ${index} :: proof ${index}`).join("\n");
      const built = setup({ script: withChecks([check]), goal });
      const { result, events } = await finish(built.kernel.run(built.log, "go"));
      expect(result.reason).toBe("done");
      expect((await goalStatus(built.log)).status).toBe("complete");
      expect(events).toContainEqual({ type: "goal", status: "complete" });
      expect(built.llm.requests.filter(isCheck)).toHaveLength(1);
    });
  }

  for (const seed of range(20, 100)) {
    it(`keeps working while items are todo, then completes (seed ${seed})`, async () => {
      const rounds = createRng(seed).int(1, 4);
      const checks = [...Array.from({ length: rounds }, (_, index) => `- [todo] part ${index} :: missing`), "- [done] all :: ok"];
      const built = setup({ script: withChecks(checks), goal });
      const { result } = await finish(built.kernel.run(built.log, "go"));
      expect(result.reason).toBe("done");
      expect((await goalStatus(built.log)).status).toBe("complete");
      expect(built.llm.requests.filter(isCheck)).toHaveLength(rounds + 1);
      const reminders = (await built.log.project()).filter((message) => message.role === "user" && textOf(message).startsWith("Goal check: the goal is not finished"));
      expect(reminders).toHaveLength(rounds);
      expect(textOf(reminders[0]!)).toContain("part 0");
    });
  }

  for (const seed of range(10, 200)) {
    it(`blocks after three human-only verdicts in a row (seed ${seed})`, async () => {
      const built = setup({ script: withChecks(["- [human] approve it :: only the owner can"]), goal });
      const { result, events } = await finish(built.kernel.run(built.log, "go"));
      expect(result).toEqual({ reason: "paused", pause: "blocked" });
      expect((await goalStatus(built.log)).status).toBe("blocked");
      expect(events).toContainEqual({ type: "goal", status: "blocked" });
      expect(built.llm.requests.filter(isCheck)).toHaveLength(3);
      expect((await built.log.branch()).at(-1)).toMatchObject({ type: "paused", reason: "blocked" });
    });
  }

  for (const seed of range(8, 300)) {
    it(`a todo verdict resets the human streak (seed ${seed})`, async () => {
      const checks = ["- [human] a :: b", "- [human] a :: b", "- [todo] x :: y", "- [human] a :: b", "- [human] a :: b", "- [done] all :: ok"];
      const built = setup({ script: withChecks(checks), goal });
      const { result } = await finish(built.kernel.run(built.log, "go"));
      expect(result.reason).toBe("done");
      expect((await goalStatus(built.log)).status).toBe("complete");
    });
  }

  for (const garbage of ["", "I am done, trust me.", "- [maybe] unsure", "DONE"]) {
    for (const variant of range(3)) {
      it(`an unreadable check (${JSON.stringify(garbage)}) never completes the goal (variant ${variant})`, async () => {
        const built = setup({ script: withChecks([garbage, "- [done] x :: y"]), goal });
        const { result } = await finish(built.kernel.run(built.log, "go"));
        expect(result.reason).toBe("done");
        expect(built.llm.requests.filter(isCheck)).toHaveLength(2);
        expect((await goalStatus(built.log)).status).toBe("complete");
      });
    }
  }

  it("the goal check request keeps the same system prompt and tools as normal requests", async () => {
    const tool = { name: "echo", description: "d", parameters: { type: "object" }, effect: "read" as const, execute: async () => ({ content: [] }) };
    const built = setup({ script: withChecks(["- [done] x :: y"]), goal, tools: [tool] });
    await finish(built.kernel.run(built.log, "go"));
    const check = built.llm.requests.find(isCheck)!;
    expect(check.system).toBe("system prompt");
    expect(check.tools.map((declared) => declared.name)).toEqual(["echo"]);
  });

  it("without a goal there is no check", async () => {
    const built = setup({ script: withChecks(["- [done] x :: y"]) });
    await finish(built.kernel.run(built.log, "go"));
    expect(built.llm.requests.some(isCheck)).toBe(false);
  });

  it("a finished goal is not checked again on later runs", async () => {
    const built = setup({ script: withChecks(["- [done] x :: y"]), goal });
    await finish(built.kernel.run(built.log, "one"));
    await finish(built.kernel.run(built.log, "two"));
    expect(built.llm.requests.filter(isCheck)).toHaveLength(1);
  });

  it("records every check as a custom entry and its tokens as usage", async () => {
    const built = setup({ script: withChecks(["- [todo] a :: b", "- [done] a :: b"]), goal });
    await finish(built.kernel.run(built.log, "go"));
    expect((await entriesOf(built.log, "custom")).length).toBe(2);
    expect((await entriesOf(built.log, "usage")).length).toBeGreaterThanOrEqual(2);
  });

  it("the check does not run while the agent is still calling tools", async () => {
    const tool = { name: "echo", description: "d", parameters: { type: "object" }, effect: "read" as const, execute: async () => ({ content: [{ type: "text" as const, text: "r" }] }) };
    const built = setup({
      script: (request) => {
        if (isCheck(request)) return { text: "- [done] x :: y" };
        return request.messages.at(-1)?.role === "user" ? { toolCalls: [{ name: "echo", args: {}, id: "c" }] } : { text: "finished" };
      },
      goal,
      tools: [tool],
    });
    await finish(built.kernel.run(built.log, "go"));
    const order = built.llm.requests.map((request) => (isCheck(request) ? "check" : "turn"));
    expect(order).toEqual(["turn", "turn", "check"]);
  });
});

describe("goal verification command", () => {
  for (const variant of range(5)) {
    it(`runs the command when everything is done and completes on success (variant ${variant})`, async () => {
      const { environment, commands } = scriptedEnv([{ exitCode: 0 }]);
      const built = setup({ script: withChecks(["- [done] x :: y"]), goal: { ...goal, verify: "npm test" }, environment });
      const { result } = await finish(built.kernel.run(built.log, "go"));
      expect(result.reason).toBe("done");
      expect(commands).toEqual(["npm test"]);
      expect((await goalStatus(built.log)).status).toBe("complete");
    });

    it(`does not complete when the command fails, and shows its output (variant ${variant})`, async () => {
      const { environment, commands } = scriptedEnv([{ exitCode: 1, output: "2 tests failed" }, { exitCode: 0 }]);
      const built = setup({ script: withChecks(["- [done] x :: y"]), goal: { ...goal, verify: "npm test" }, environment });
      const { result } = await finish(built.kernel.run(built.log, "go"));
      expect(result.reason).toBe("done");
      expect(commands).toHaveLength(2);
      const failure = (await built.log.project()).find((message) => textOf(message).includes("verification command failed"));
      expect(textOf(failure!)).toContain("2 tests failed");
      expect((await goalStatus(built.log)).status).toBe("complete");
    });
  }

  it("does not run the command while items are still todo", async () => {
    const { environment, commands } = scriptedEnv([{ exitCode: 0 }]);
    const built = setup({ script: withChecks(["- [todo] x :: y", "- [done] x :: y"]), goal: { ...goal, verify: "check" }, environment });
    await finish(built.kernel.run(built.log, "go"));
    expect(commands).toEqual(["check"]);
  });
});

describe("goal and the queue", () => {
  it("queued messages are handled after the goal is complete", async () => {
    const built = setup({ script: withChecks(["- [done] x :: y"]), goal });
    const handle = built.kernel.run(built.log, "go");
    handle.queue("one more thing");
    const { result } = await finish(handle);
    expect(result.reason).toBe("done");
    expect((await built.log.project()).some((message) => textOf(message) === "one more thing")).toBe(true);
  });
});

describe("usage of the goal check", () => {
  it("the tokens of a goal check are written to the log as their own entry", async () => {
    const built = setup({
      script: (request) => (textOf(request.messages.at(-1)!).startsWith("You are about to stop.") ? { text: "- [done] it :: seen", usage: { input: 5, output: 3 } } : { text: "done" }),
      goal: { objective: "do it" },
    });
    await finish(built.kernel.run(built.log, "go"));
    const usage = (await built.log.branch()).filter((entry) => entry.type === "usage") as Array<{ kind: string; usage: { input: number; output: number } }>;
    expect(usage.filter((entry) => entry.kind === "goal_check").map((entry) => [entry.usage.input, entry.usage.output])).toEqual([[5, 3]]);
  });
});

describe("parseChecklist: items without evidence", () => {
  it("gives an empty note when there is nothing after the item", () => {
    expect(parseChecklist("- [todo] write the tests")).toEqual([{ status: "todo", text: "write the tests", note: "" }]);
    expect(parseChecklist("[DONE] item :: seen in output")).toEqual([{ status: "done", text: "item", note: "seen in output" }]);
  });
});
