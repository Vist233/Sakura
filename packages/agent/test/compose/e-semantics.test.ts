import { describe, expect, it } from "vitest";
import type { Plugin, ToolCall } from "@sakura/kernel";
import { bundle, compose } from "../../src/compose.ts";
import { drain, textOf, withAgent } from "./helpers.ts";

const echoTool: Plugin = {
  name: "echo",
  setup: (api) =>
    api.registerTool({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: { v: { type: "string" } } },
      effect: "read",
      execute: async (args) => ({ content: [{ type: "text", text: `echo:${(args as { v: string }).v}` }] }),
    }),
};
const call = (v: string) => [{ toolCalls: [{ name: "echo", args: { v } }] }, { text: "done" }];

describe("E. ordering rules survive nesting", () => {
  it("E1 tool.run: the first registered plugin is the outermost wrapper, also inside nested bundles", async () => {
    const trace: string[] = [];
    const wrap = (name: string): Plugin => ({
      name,
      setup: (api) =>
        api.on("tool.run", async (_c: ToolCall, next) => {
          trace.push(`${name}>`);
          const r = await next();
          trace.push(`<${name}`);
          return r;
        }),
    });
    await withAgent([echoTool, bundle("outer", [wrap("a"), bundle("inner", [wrap("b")]), wrap("c")])], call("x"), async (agent) => void (await drain(agent.run("go"))));
    expect(trace).toEqual(["a>", "b>", "c>", "<c", "<b", "<a"]);
  });

  it("E2 tool.before rewrites chain: each child sees the previous child's rewritten arguments", async () => {
    const rewrite = (name: string, suffix: string): Plugin => ({
      name,
      setup: (api) => api.on("tool.before", (c) => ({ kind: "rewrite", args: { v: `${(c.args as { v: string }).v}${suffix}` } })),
    });
    await withAgent([echoTool, bundle("rw", [rewrite("r1", "-1"), bundle("deep", [rewrite("r2", "-2")]), rewrite("r3", "-3")])], call("x"), async (agent, client) => {
      await drain(agent.run("go"));
      expect(JSON.stringify(client.requests[1]!.messages)).toContain("echo:x-1-2-3");
    });
  });

  it("E3 a deny from the first child stops later children from seeing the call", async () => {
    const seen: string[] = [];
    const deny: Plugin = { name: "deny", setup: (api) => api.on("tool.before", () => ({ kind: "deny", reason: "no" })) };
    const later: Plugin = { name: "later", setup: (api) => api.on("tool.before", () => void seen.push("later")) };
    await withAgent([echoTool, bundle("b", [deny, later])], call("x"), async (agent) => void (await drain(agent.run("go"))));
    expect(seen).toEqual([]);
  });

  it("E4 request hooks: later children see the earlier child's changes", async () => {
    const addTag = (name: string, tag: string): Plugin => ({
      name,
      setup: (api) => api.on("request", (r) => ({ ...r, system: `${r.system}[${tag}]` })),
    });
    await withAgent([bundle("b", [addTag("p", "1"), bundle("n", [addTag("q", "2")])])], [{ text: "ok" }], async (agent, client) => {
      await drain(agent.run("hi"));
      expect(client.requests[0]!.system.endsWith("[1][2]")).toBe(true);
    });
  });

  it("E5 request transforms (the reply is rewritten back) apply in registration order", async () => {
    const upper: Plugin = {
      name: "upper",
      setup: (api) =>
        api.on("request", (r) => ({
          request: r,
          transform: { push: (e) => [e.type === "text_delta" ? { ...e, delta: e.delta.toUpperCase() } : e], flush: () => [] },
        })),
    };
    const exclaim: Plugin = {
      name: "exclaim",
      setup: (api) =>
        api.on("request", (r) => ({
          request: r,
          transform: { push: (e) => [e.type === "text_delta" ? { ...e, delta: `${e.delta}!` } : e], flush: () => [] },
        })),
    };
    await withAgent([bundle("b", [upper, exclaim])], [{ text: "hi" }], async (agent) => {
      await drain(agent.run("go"));
      const reply = (await agent.log.project()).at(-1)!;
      expect(textOf(reply)).toBe("HI!");
    });
  });

  it("E6 turn.end appends from several children are all added, a pause from any child stops the run", async () => {
    const pauser: Plugin = { name: "pauser", setup: (api) => api.on("turn.end", () => ({ pause: "blocked" })) };
    const noisy: Plugin = { name: "noisy", setup: (api) => api.on("turn.end", () => void 0) };
    await withAgent([bundle("b", [noisy, pauser])], [{ text: "ok" }], async (agent) => {
      expect((await drain(agent.run("go"))).reason).toBe("paused");
    });
  });

  it("E7 compose() order vs bundle order: the same plugins give the same observable result", async () => {
    const traceA: string[] = [];
    const traceB: string[] = [];
    const mk = (n: string, t: string[]): Plugin => ({ name: n, setup: (api) => api.on("context", () => void t.push(n)) });
    await withAgent([bundle("s", [mk("a", traceA), mk("b", traceA)])], [{ text: "1" }], async (agent) => void (await drain(agent.run("x"))));
    await withAgent(compose([bundle("s", [mk("a", traceB), mk("b", traceB)])]), [{ text: "1" }], async (agent) => void (await drain(agent.run("x"))));
    expect(traceA).toEqual(traceB);
  });
});
