// Exact-behaviour tests for hooks.ts (see compaction-exact.test.ts for why they exist).
import { describe, expect, it } from "vitest";
import { createHookSet } from "../src/hooks.ts";
import { FatalHookError } from "../src/index.ts";
import type { Decision, HookContext, Message, Plugin, Tool, ToolResult } from "../src/index.ts";

const msg = (value: string): Message => ({ role: "user", content: [{ type: "text", text: value }], ts: 1 });
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const result = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const make = (plugins: Plugin[]) => {
  const reports: string[] = [];
  const set = createHookSet(
    plugins,
    [],
    (plugin, hook) => reports.push(`${plugin}:${hook}`),
    () => undefined,
  );
  return { set, reports };
};
const call = { id: "c", name: "t", args: { x: 1 } };
const context = {} as HookContext;

describe("request hooks", () => {
  it("a hook that returns nothing leaves the request alone", () => {
    const { set } = make([{ name: "p", setup: (api) => api.on("request", () => undefined) }]);
    const request = { system: "s", messages: [], tools: [] };
    expect(set.request(request)).toEqual({ request, transforms: [] });
  });
  it("a plain request replaces it; {request, transform} also collects the transform; later hooks see the earlier result", () => {
    const transform = { push: (event: never) => [event], flush: () => [] };
    const { set } = make([
      { name: "a", setup: (api) => api.on("request", (r) => ({ request: { ...r, system: `${r.system}+a` }, transform })) },
      { name: "b", setup: (api) => api.on("request", (r) => ({ ...r, system: `${r.system}+b` })) },
      { name: "c", setup: (api) => api.on("request", (r) => ({ request: { ...r, system: `${r.system}+c` } })) },
    ]);
    const out = set.request({ system: "s", messages: [], tools: [] });
    expect(out.request.system).toBe("s+a+b+c");
    expect(out.transforms).toEqual([transform]);
  });
  it("a FatalHookError is not swallowed", () => {
    const { set } = make([
      {
        name: "p",
        setup: (api) =>
          api.on("request", () => {
            throw new FatalHookError("stop");
          }),
      },
    ]);
    expect(() => set.request({ system: "s", messages: [], tools: [] })).toThrow(FatalHookError);
  });
  it("any other error is reported with the plugin and hook name and the rest still run", () => {
    const { set, reports } = make([
      {
        name: "bad",
        setup: (api) =>
          api.on("request", () => {
            throw new Error("x");
          }),
      },
      { name: "good", setup: (api) => api.on("request", (r) => ({ ...r, system: "changed" })) },
    ]);
    expect(set.request({ system: "s", messages: [], tools: [] }).request.system).toBe("changed");
    expect(reports).toEqual(["bad:request"]);
  });
});

describe("tool.before", () => {
  const before = (...handlers: Array<(c: typeof call, ctx: HookContext) => Decision | void | Promise<Decision | void>>) =>
    make(handlers.map((handler, index) => ({ name: `p${index}`, setup: (api) => api.on("tool.before", handler as never) })));

  it("no hooks, or hooks that return nothing or allow, allow with the original arguments", async () => {
    expect(await before().set.toolBefore(call, context)).toEqual({ decision: { kind: "allow" }, args: { x: 1 } });
    expect(
      await before(
        () => undefined,
        () => ({ kind: "allow" }),
      ).set.toolBefore(call, context),
    ).toEqual({ decision: { kind: "allow" }, args: { x: 1 } });
  });
  it("deny stops at once: later hooks are not asked", async () => {
    let asked = false;
    const { set } = before(
      () => ({ kind: "deny", reason: "no" }),
      () => {
        asked = true;
      },
    );
    expect(await set.toolBefore(call, context)).toEqual({ decision: { kind: "deny", reason: "no" }, args: { x: 1 } });
    expect(asked).toBe(false);
  });
  it("rewrite changes the arguments for the next hook and for the call", async () => {
    const seen: unknown[] = [];
    const { set } = before(
      () => ({ kind: "rewrite", args: { x: 2 } }),
      (c) => {
        seen.push(c.args);
        return { kind: "rewrite", args: { x: 3 } };
      },
    );
    expect(await set.toolBefore(call, context)).toEqual({ decision: { kind: "allow" }, args: { x: 3 } });
    expect(seen).toEqual([{ x: 2 }]);
  });
  it("a hook that throws denies the call and names the plugin", async () => {
    const { set, reports } = before(() => {
      throw new Error("broken");
    });
    const outcome = await set.toolBefore(call, context);
    expect(outcome.decision).toEqual({ kind: "deny", reason: "The check by 'p0' failed, so the call was not allowed." });
    expect(reports).toEqual(["p0:tool.before"]);
  });
  it("async hooks are awaited", async () => {
    const { set } = before(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { kind: "deny", reason: "late" };
    });
    expect((await set.toolBefore(call, context)).decision).toEqual({ kind: "deny", reason: "late" });
  });
});

describe("tool.run and tool.after", () => {
  it("the first registered run hook is the outermost wrapper", async () => {
    const order: string[] = [];
    const wrap = (name: string): Plugin => ({
      name,
      setup: (api) =>
        api.on("tool.run", async (_c, next) => {
          order.push(`${name}>`);
          const r = await next();
          order.push(`<${name}`);
          return r;
        }),
    });
    const { set } = make([wrap("outer"), wrap("inner")]);
    await set.toolRun(call, async () => {
      order.push("base");
      return result("r");
    });
    expect(order).toEqual(["outer>", "inner>", "base", "<inner", "<outer"]);
  });
  it("a run hook that throws is reported and skipped: the rest of the chain still runs", async () => {
    const { set, reports } = make([
      {
        name: "bad",
        setup: (api) =>
          api.on("tool.run", () => {
            throw new Error("x");
          }),
      },
    ]);
    expect(await set.toolRun(call, async () => result("base result"))).toEqual(result("base result"));
    expect(reports).toEqual(["bad:tool.run"]);
  });
  it("after hooks can replace the result; returning nothing keeps it; each sees the previous", () => {
    const { set } = make([
      { name: "a", setup: (api) => api.on("tool.after", (_c, r) => result(`${(r.content[0] as { text: string }).text}+a`)) },
      { name: "b", setup: (api) => api.on("tool.after", () => undefined) },
      { name: "c", setup: (api) => api.on("tool.after", (_c, r) => result(`${(r.content[0] as { text: string }).text}+c`)) },
    ]);
    expect(set.toolAfter(call, result("r"))).toEqual(result("r+a+c"));
  });
});

describe("context", () => {
  it("a hook that returns nothing keeps the messages; one that returns a list replaces them", () => {
    const { set } = make([
      { name: "keep", setup: (api) => api.on("context", () => undefined) },
      { name: "drop", setup: (api) => api.on("context", ({ messages }) => messages.slice(1)) },
    ]);
    expect(set.context([msg("a"), msg("b")]).map(textOf)).toEqual(["b"]);
  });
});

describe("turn.end", () => {
  const turn = {} as never;
  it("collects messages from every hook in order, and the first pause wins", () => {
    const { set } = make([
      { name: "a", setup: (api) => api.on("turn.end", () => ({ append: [msg("one")], pause: "budget" })) },
      { name: "b", setup: (api) => api.on("turn.end", () => ({ append: [msg("two")], pause: "quota" })) },
      { name: "c", setup: (api) => api.on("turn.end", () => undefined) },
      { name: "d", setup: (api) => api.on("turn.end", () => ({})) },
    ]);
    const outcome = set.turnEnd(turn);
    expect(outcome.append.map(textOf)).toEqual(["one", "two"]);
    expect(outcome.pause).toBe("budget");
  });
  it("with no hooks nothing is appended and nothing pauses", () => {
    expect(make([]).set.turnEnd(turn)).toEqual({ append: [], pause: undefined });
  });
  it("a hook with only append does not pause", () => {
    const { set } = make([{ name: "a", setup: (api) => api.on("turn.end", () => ({ append: [msg("x")] })) }]);
    expect(set.turnEnd(turn).pause).toBeUndefined();
  });
});

describe("error hooks", () => {
  const error = {} as never;
  it("the first hook that asks for a pause decides", () => {
    const { set } = make([
      { name: "a", setup: (api) => api.on("error", () => undefined) },
      { name: "b", setup: (api) => api.on("error", () => ({ pause: "quota" })) },
      { name: "c", setup: (api) => api.on("error", () => ({ pause: "budget" })) },
    ]);
    expect(set.error(error)).toBe("quota");
  });
  it("a result without pause is not a pause, and no hooks means no pause", () => {
    expect(make([{ name: "a", setup: (api) => api.on("error", () => ({})) }]).set.error(error)).toBeUndefined();
    expect(make([]).set.error(error)).toBeUndefined();
  });
});

describe("event hooks", () => {
  it("every observer sees every event; a failing one is reported and the others still see it", () => {
    const seen: string[] = [];
    const { set, reports } = make([
      {
        name: "bad",
        setup: (api) =>
          api.on("event", () => {
            throw new Error("x");
          }),
      },
      {
        name: "good",
        setup: (api) =>
          api.on("event", (event) => {
            seen.push(event.type);
          }),
      },
    ]);
    set.event({ type: "run_start" });
    expect(seen).toEqual(["run_start"]);
    expect(reports).toEqual(["bad:event"]);
  });
});

describe("tool registration", () => {
  const tool = (name: string): Tool => ({ name, description: "", parameters: {}, effect: "read", execute: async () => result("") });
  it("two plugins registering the same name is an error that names the second one", () => {
    expect(() =>
      make([
        { name: "first", setup: (api) => api.registerTool(tool("t")) },
        { name: "second", setup: (api) => api.registerTool(tool("t")) },
      ]),
    ).toThrow(/second.*already exists: t/);
  });
});
