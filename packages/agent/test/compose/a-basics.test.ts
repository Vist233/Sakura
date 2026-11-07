import { describe, expect, it } from "vitest";
import type { Plugin } from "@sakura/kernel";
import { bundle } from "../../src/compose.ts";
import { drain, naiveBundle, textOf, withAgent } from "./helpers.ts";

const tracer = (name: string, log: string[], extra: Partial<Plugin> = {}): Plugin => ({
  name,
  setup(api) {
    api.on("context", () => void log.push(`${name}:context`));
    api.on("request", () => void log.push(`${name}:request`));
  },
  ...extra,
});

describe("A. a plugin that contains plugins", () => {
  it("A1 children's hooks all run, in the order the children are listed", async () => {
    const seen: string[] = [];
    const plugin = bundle("suite", [tracer("a", seen), tracer("b", seen), tracer("c", seen)]);
    await withAgent([plugin], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(seen).toEqual(["a:context", "b:context", "c:context", "a:request", "b:request", "c:request"]);
  });

  it("A2 nesting three levels deep flattens to the same order", async () => {
    const seen: string[] = [];
    const inner = bundle("inner", [tracer("c", seen), tracer("d", seen)]);
    const middle = bundle("middle", [tracer("b", seen), inner]);
    const outer = bundle("outer", [tracer("a", seen), middle, tracer("e", seen)]);
    await withAgent([outer], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(seen.filter((line) => line.endsWith(":context"))).toEqual(["a", "b", "c", "d", "e"].map((n) => `${n}:context`));
  });

  it("A3 the naive bundle silently drops prepare (the bug a helper must avoid)", async () => {
    const calls: string[] = [];
    const child = tracer("child", [], { prepare: async () => void calls.push("prepare") });
    await withAgent([naiveBundle("naive", [child])], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(calls).toEqual([]);
  });

  it("A4 the real bundle forwards prepare, once per run, in child order", async () => {
    const calls: string[] = [];
    const mk = (n: string) => tracer(n, [], { prepare: async () => void calls.push(n) });
    await withAgent([bundle("suite", [mk("x"), bundle("sub", [mk("y")]), mk("z")])], [{ text: "1" }, { text: "2" }], async (agent) => {
      await drain(agent.run("a"));
      await drain(agent.run("b"));
    });
    expect(calls).toEqual(["x", "y", "z", "x", "y", "z"]);
  });

  it("A5 afterCompaction is forwarded too", async () => {
    const calls: string[] = [];
    const child = tracer("child", [], { afterCompaction: async () => void calls.push("after") });
    const plugin = bundle("suite", [child]);
    expect(typeof plugin.afterCompaction).toBe("function");
    await plugin.afterCompaction!({ log: undefined as never, env: undefined as never });
    expect(calls).toEqual(["after"]);
  });

  it("A6 a bundle without prepare children has no prepare (nothing extra is registered)", () => {
    const plugin = bundle("suite", [tracer("a", [])]);
    expect(plugin.prepare).toBeUndefined();
    expect(plugin.afterCompaction).toBeUndefined();
  });

  it("A7 tools registered by children reach the model", async () => {
    const tool = (name: string): Plugin => ({
      name: `${name}-plugin`,
      setup: (api) => api.registerTool({ name, description: name, parameters: { type: "object", properties: {} }, effect: "read", execute: async () => ({ content: [{ type: "text", text: name }] }) }),
    });
    await withAgent([bundle("suite", [tool("alpha"), bundle("sub", [tool("beta")])])], [{ text: "ok" }], async (agent, client) => {
      await drain(agent.run("hi"));
      const names = client.requests[0]!.tools.map((t) => t.name);
      expect(names).toContain("alpha");
      expect(names).toContain("beta");
    });
  });

  it("A8 compensates of children is carried to the bundle (so it can still be found and deleted)", () => {
    const plugin = bundle("suite", [tracer("a", [], { compensates: "weak model A" }), tracer("b", [], { compensates: "weak model B" })]);
    expect(plugin.compensates).toBe("weak model A; weak model B");
  });

  it("A9 a bundle is itself usable where a plugin is expected, with a user message intact", async () => {
    await withAgent([bundle("empty", [])], [{ text: "fine" }], async (agent, client) => {
      expect((await drain(agent.run("hello"))).reason).toBe("done");
      expect(client.requests[0]!.messages.map(textOf)).toEqual(["hello"]);
    });
  });
});
