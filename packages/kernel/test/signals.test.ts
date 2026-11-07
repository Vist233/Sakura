import { describe, expect, it } from "vitest";
import type { Event, Plugin, Tool, ToolContext } from "../src/index.ts";
import { createMemoryLog } from "@sakura/session";
import { delay, finish, setup, text, textOf } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const notifying = (...messages: string[]): Tool => ({
  name: "ping",
  description: "",
  parameters: {},
  effect: "read",
  execute: async (_args, context: ToolContext) => {
    for (const message of messages) context.notify(message);
    return { content: text("ok") };
  },
});
const callPing = (id = "c") => ({ toolCalls: [{ name: "ping", args: {}, id }] });

describe("signals: a tool says something changed", () => {
  for (const count of range(5)) {
    it(`${count} notifications from one turn become one message before the next request`, async () => {
      const messages = Array.from({ length: count }, (_, index) => `change ${index}`);
      const built = setup({ script: [callPing(), { text: "done" }], tools: [notifying(...messages)] });
      await finish(built.kernel.run(built.log, "go"));
      const second = built.llm.requests[1]!.messages;
      const notice = second.at(-1)!;
      expect(notice.role).toBe("user");
      for (const message of messages) expect(textOf(notice)).toContain(message);
      expect(second.filter((item) => textOf(item).includes("since your last turn"))).toHaveLength(1);
    });
  }

  it("is recorded in the log as a signal message", async () => {
    const built = setup({ script: [callPing(), { text: "done" }], tools: [notifying("the build finished")] });
    await finish(built.kernel.run(built.log, "go"));
    const entry = (await built.log.branch()).find((item) => item.type === "custom_message" && item.customType === "signal");
    expect(entry).toBeDefined();
  });

  it("uses a fixed sentence and lists each change on its own line", async () => {
    const built = setup({ script: [callPing(), { text: "done" }], tools: [notifying("first", "second")] });
    await finish(built.kernel.run(built.log, "go"));
    const notice = textOf(built.llm.requests[1]!.messages.at(-1)!);
    expect(notice).toMatch(/^Notice: since your last turn/);
    expect(notice.split("\n").filter((line) => line.startsWith("- "))).toEqual(["- first", "- second"]);
  });

  it("emits a signal event the moment it happens", async () => {
    const built = setup({ script: [callPing(), { text: "done" }], tools: [notifying("hello")] });
    const { events } = await finish(built.kernel.run(built.log, "go"));
    expect(events.filter((event: Event) => event.type === "signal")).toEqual([{ type: "signal", text: "hello" }]);
  });

  it("without notifications nothing is added", async () => {
    const built = setup({ script: [callPing(), { text: "done" }], tools: [notifying()] });
    await finish(built.kernel.run(built.log, "go"));
    expect((await built.log.branch()).some((item) => item.type === "custom_message")).toBe(false);
  });

  it("a notice that was delivered is not repeated", async () => {
    const built = setup({ script: [callPing("a"), callPing("b"), { text: "done" }], tools: [notifying("once")] });
    await finish(built.kernel.run(built.log, "go"));
    const notices = (index: number) => built.llm.requests[index]!.messages.filter((message) => textOf(message).startsWith("Notice:")).length;
    expect([notices(0), notices(1), notices(2)]).toEqual([0, 1, 2]); // one new notice per turn, none re-sent
  });
});

describe("signals: when the agent is already finishing", () => {
  it("a notification that arrives as the run ends waits for the next run", async () => {
    let context: ToolContext | undefined;
    const grab: Tool = {
      name: "grab",
      description: "",
      parameters: {},
      effect: "read",
      execute: async (_a, ctx) => {
        context = ctx;
        return { content: text("ok") };
      },
    };
    const built = setup({ script: [{ toolCalls: [{ name: "grab", args: {}, id: "g" }] }, { text: "finished" }, { text: "second run" }], tools: [grab] });
    await finish(built.kernel.run(built.log, "one"));
    context!.notify("a late change");
    expect(built.llm.requests).toHaveLength(2); // no extra run was started for it
    await finish(built.kernel.run(built.log, "two"));
    const last = built.llm.requests.at(-1)!.messages;
    expect(last.some((message) => textOf(message).includes("a late change"))).toBe(true);
    expect(textOf(last.at(-1)!)).toBe("two");
  });

  it("is placed before the user's new message of the next run, not after it", async () => {
    let context: ToolContext | undefined;
    const grab: Tool = {
      name: "grab",
      description: "",
      parameters: {},
      effect: "read",
      execute: async (_a, ctx) => {
        context = ctx;
        return { content: text("ok") };
      },
    };
    const built = setup({ script: [{ toolCalls: [{ name: "grab", args: {}, id: "g" }] }, { text: "f" }, { text: "again" }], tools: [grab] });
    await finish(built.kernel.run(built.log, "one"));
    context!.notify("between runs");
    await finish(built.kernel.run(built.log, "two"));
    const roles = built.llm.requests.at(-1)!.messages.map((message) => textOf(message).slice(0, 7));
    expect(roles.at(-2)).toBe("Notice:");
    expect(roles.at(-1)).toBe("two");
  });

  it("notifications are kept per conversation", async () => {
    let context: ToolContext | undefined;
    const grab: Tool = {
      name: "grab",
      description: "",
      parameters: {},
      effect: "read",
      execute: async (_a, ctx) => {
        context = ctx;
        return { content: text("ok") };
      },
    };
    const built = setup({ script: [{ toolCalls: [{ name: "grab", args: {}, id: "g" }] }, { text: "f" }, { text: "other log" }], tools: [grab] });
    await finish(built.kernel.run(built.log, "one"));
    context!.notify("for the first log only");
    await finish(built.kernel.run(createMemoryLog(), "elsewhere"));
    expect(built.llm.requests.at(-1)!.messages.map(textOf).join("\n")).not.toContain("first log only");
  });
});

describe("signals from plugins", () => {
  it("a plugin can use notify through the tools it registers", async () => {
    const p: Plugin = { name: "watcher", setup: (api) => api.registerTool(notifying("from a plugin tool")) };
    const built = setup({ script: [callPing(), { text: "done" }], plugins: [p] });
    await finish(built.kernel.run(built.log, "go"));
    expect(textOf(built.llm.requests[1]!.messages.at(-1)!)).toContain("from a plugin tool");
  });
  it("delays are fine: a notification sent after the tool returned still arrives", async () => {
    let calls = 0;
    const slow: Tool = {
      name: "slow",
      description: "",
      parameters: {},
      effect: "read",
      execute: async (_a, ctx) => {
        if (++calls === 1) setTimeout(() => ctx.notify("later"), 20);
        else await delay(60);
        return { content: text("ok") };
      },
    };
    const built = setup({ script: [{ toolCalls: [{ name: "slow", args: {}, id: "s" }] }, { toolCalls: [{ name: "slow", args: {}, id: "t" }] }, { text: "done" }], tools: [slow] });
    await finish(built.kernel.run(built.log, "go"));
    expect(built.llm.requests[2]!.messages.some((message) => textOf(message).includes("later"))).toBe(true);
  });
});
