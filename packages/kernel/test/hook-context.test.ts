import { describe, expect, it } from "vitest";
import type { Plugin } from "../src/index.ts";
import { delay, echo, finish, runOnce, text, textOf, tool } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const plugin = (name: string, setupFn: Plugin["setup"]): Plugin => ({ name, setup: setupFn });
const oneCall = [{ toolCalls: [{ name: "echo", args: { a: 1 }, id: "c1" }] }, { text: "done" }];

describe("tool.before may be asynchronous and sees the context", () => {
  for (const wait of [0, 1, 5, 20]) {
    for (const verdict of ["allow", "deny"] as const) {
      it(`waits ${wait} ms and then ${verdict}s`, async () => {
        let ran = false;
        const t = tool("echo", () => {
          ran = true;
          return { content: text("ran") };
        });
        const p = plugin("slow", (api) =>
          api.on("tool.before", async () => {
            await delay(wait);
            return verdict === "deny" ? { kind: "deny", reason: "slow no" } : { kind: "allow" };
          }),
        );
        const { log } = await runOnce({ script: oneCall, tools: [t], plugins: [p] });
        expect(ran).toBe(verdict === "allow");
        expect((await log.project()).some((message) => message.isError)).toBe(verdict === "deny");
      });
    }
  }

  it("a rejected promise denies the call", async () => {
    const p = plugin("broken", (api) =>
      api.on("tool.before", async () => {
        throw new Error("late failure");
      }),
    );
    const { log } = await runOnce({ script: oneCall, tools: [echo()], plugins: [p] });
    expect(textOf((await log.project()).find((message) => message.role === "tool")!)).toContain("failed");
  });

  for (const seed of range(10)) {
    it(`gets the log, the environment, the abort signal and tool lookup (seed ${seed})`, async () => {
      let seen: { branch: number; cwd: string; effect: string | undefined; unknown: unknown; aborted: boolean } | undefined;
      const p = plugin("looker", (api) =>
        api.on("tool.before", async (_call, context) => {
          seen = { branch: (await context.log.branch()).length, cwd: context.env.cwd, effect: context.tool("echo")?.effect, unknown: context.tool("nope"), aborted: context.signal.aborted };
        }),
      );
      await runOnce({ script: oneCall, tools: [echo()], plugins: [p] });
      expect(seen).toEqual({ branch: 3, cwd: "/work", effect: "read", unknown: undefined, aborted: false });
    });
  }

  it("the context log includes what happened so far in the run", async () => {
    const lengths: number[] = [];
    const p = plugin("count", (api) => api.on("tool.before", async (_call, context) => void lengths.push((await context.log.branch()).length)));
    await runOnce({ script: [{ toolCalls: [{ name: "echo", args: {}, id: "a" }] }, { toolCalls: [{ name: "echo", args: {}, id: "b" }] }, { text: "d" }], tools: [echo()], plugins: [p] });
    expect(lengths).toEqual([3, 5]);
  });
});

describe("plugin emit", () => {
  for (const seed of range(8, 100)) {
    it(`sends a plugin event with the plugin's name (seed ${seed})`, async () => {
      const p = plugin("announcer", (api) => api.on("turn.end", () => api.emit({ turn: seed })));
      const { events } = await runOnce({ script: [{ text: "a" }], plugins: [p] });
      expect(events.filter((event) => event.type === "plugin")).toContainEqual({ type: "plugin", name: "announcer", data: { turn: seed } });
    });
  }

  it("observers see emitted events", async () => {
    const seen: unknown[] = [];
    const announcer = plugin("announcer", (api) => api.on("turn.end", () => api.emit("hello")));
    const watcher = plugin("watcher", (api) =>
      api.on("event", (event) => {
        if (event.type === "plugin") seen.push(event.data);
      }),
    );
    await runOnce({ script: [{ text: "a" }], plugins: [announcer, watcher] });
    expect(seen).toEqual(["hello"]);
  });

  it("emitting outside a run is harmless", () => {
    let emit: ((data: unknown) => void) | undefined;
    plugin("x", (api) => {
      emit = api.emit;
    }).setup({ on: () => undefined, registerTool: () => undefined, emit: () => undefined });
    expect(() => emit?.("x")).not.toThrow();
  });

  it("concurrent runs both receive events", async () => {
    const p = plugin("announcer", (api) => api.on("turn.end", () => api.emit("tick")));
    const a = await runOnce({ script: [{ text: "a" }], plugins: [p] });
    const b = await runOnce({ script: [{ text: "b" }], plugins: [p] });
    expect(a.events.some((event) => event.type === "plugin")).toBe(true);
    expect(b.events.some((event) => event.type === "plugin")).toBe(true);
    void finish;
  });
});
