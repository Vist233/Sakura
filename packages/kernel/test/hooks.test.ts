import { describe, expect, it } from "vitest";
import type { Plugin, Tool } from "../src/index.ts";
import { createKernel } from "../src/index.ts";
import { echo, env, finish, runOnce, setup, text, textOf, tool } from "./helpers.ts";
import { createFauxClient } from "@sakura/testing";
import { createMemoryLog } from "@sakura/session";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const plugin = (name: string, setupFn: Plugin["setup"]): Plugin => ({ name, setup: setupFn });
const oneCall = (name = "echo", args: unknown = {}) => [{ toolCalls: [{ name, args, id: "c1" }] }, { text: "done" }];

describe("hooks: context and request", () => {
  for (const seed of range(10)) {
    it(`context hook changes what the model sees but not the log (seed ${seed})`, async () => {
      const note = `note ${seed}`;
      const p = plugin("noter", (api) => api.on("context", ({ messages }) => [...messages, { role: "user", content: text(note), ts: 1 }]));
      const { llm, log } = await runOnce({ script: [{ text: "a" }], plugins: [p] });
      expect(llm.requests[0]?.messages.map(textOf)).toEqual(["go", note]);
      expect((await log.project()).map(textOf)).toEqual(["go", "a"]);
    });
  }

  for (const seed of range(10, 20)) {
    it(`request hooks run in plugin order and can change tools and parameters (seed ${seed})`, async () => {
      const seen: string[] = [];
      const first = plugin("first", (api) =>
        api.on("request", (request) => {
          seen.push(`first:${request.maxTokens ?? "none"}`);
          return { ...request, maxTokens: seed };
        }),
      );
      const second = plugin("second", (api) =>
        api.on("request", (request) => {
          seen.push(`second:${request.maxTokens}`);
          return { ...request, tools: [] };
        }),
      );
      const { llm } = await runOnce({ script: [{ text: "a" }], plugins: [first, second], tools: [echo()] });
      expect(seen).toEqual(["first:none", `second:${seed}`]);
      expect(llm.requests[0]?.maxTokens).toBe(seed);
      expect(llm.requests[0]?.tools).toEqual([]);
    });
  }

  it("a hook that returns nothing leaves the request alone", async () => {
    const p = plugin("quiet", (api) => api.on("request", () => undefined));
    const { llm } = await runOnce({ script: [{ text: "a" }], plugins: [p], tools: [echo()] });
    expect(llm.requests[0]?.tools).toHaveLength(1);
  });
});

describe("hooks: tool.before", () => {
  for (const seed of range(10, 40)) {
    it(`deny stops the tool and tells the model why (seed ${seed})`, async () => {
      let ran = false;
      const guarded = tool("guarded", () => {
        ran = true;
        return { content: text("ran") };
      });
      const p = plugin("guard", (api) => api.on("tool.before", () => ({ kind: "deny", reason: `reason ${seed}` })));
      const { log } = await runOnce({ script: oneCall("guarded"), tools: [guarded], plugins: [p] });
      const answer = (await log.project()).find((message) => message.role === "tool");
      expect(ran).toBe(false);
      expect(answer?.isError).toBe(true);
      expect(textOf(answer!)).toBe(`Not allowed: reason ${seed}`);
    });
  }

  for (const seed of range(10, 50)) {
    it(`rewrite changes the arguments the tool receives (seed ${seed})`, async () => {
      const received: unknown[] = [];
      const spy = tool("spy", (args) => {
        received.push(args);
        return { content: text("ok") };
      });
      const a = plugin("a", (api) => api.on("tool.before", (call) => ({ kind: "rewrite", args: { value: seed, original: call.args } })));
      const b = plugin("b", (api) => api.on("tool.before", (call) => ({ kind: "rewrite", args: { wrapped: call.args } })));
      await runOnce({ script: oneCall("spy", { raw: true }), tools: [spy], plugins: [a, b] });
      expect(received).toEqual([{ wrapped: { value: seed, original: { raw: true } } }]);
    });
  }

  it("a handler that throws denies the call", async () => {
    let ran = false;
    const t = tool("t", () => {
      ran = true;
      return { content: text("x") };
    });
    const p = plugin("broken", (api) =>
      api.on("tool.before", () => {
        throw new Error("oops");
      }),
    );
    const { log, events } = await runOnce({ script: oneCall("t"), tools: [t], plugins: [p] });
    expect(ran).toBe(false);
    expect(textOf((await log.project()).find((message) => message.role === "tool")!)).toContain("failed");
    expect(events.some((event) => event.type === "plugin")).toBe(true);
  });

  it("the first deny wins and later hooks are not asked", async () => {
    let asked = false;
    const first = plugin("first", (api) => api.on("tool.before", () => ({ kind: "deny", reason: "no" })));
    const second = plugin("second", (api) =>
      api.on("tool.before", () => {
        asked = true;
      }),
    );
    await runOnce({ script: oneCall(), tools: [echo()], plugins: [first, second] });
    expect(asked).toBe(false);
  });
});

describe("hooks: tool.run and tool.after", () => {
  for (const seed of range(10, 60)) {
    it(`wrappers nest in plugin order (seed ${seed})`, async () => {
      const order: string[] = [];
      const t = tool("t", () => {
        order.push("tool");
        return { content: text("ok") };
      });
      const mk = (name: string) =>
        plugin(name, (api) =>
          api.on("tool.run", async (_call, next) => {
            order.push(`${name} in`);
            const r = await next();
            order.push(`${name} out`);
            return r;
          }),
        );
      await runOnce({ script: oneCall("t"), tools: [t], plugins: [mk("outer"), mk("inner")] });
      expect(order).toEqual(["outer in", "inner in", "tool", "inner out", "outer out"]);
    });
  }

  it("a wrapper can answer without running the tool", async () => {
    let ran = false;
    const t = tool("t", () => {
      ran = true;
      return { content: text("real") };
    });
    const p = plugin("cache", (api) => api.on("tool.run", async () => ({ content: text("cached") })));
    const { log } = await runOnce({ script: oneCall("t"), tools: [t], plugins: [p] });
    expect(ran).toBe(false);
    expect(textOf((await log.project()).find((message) => message.role === "tool")!)).toBe("cached");
  });

  it("a wrapper that throws is skipped and the tool still runs", async () => {
    const p = plugin("broken", (api) =>
      api.on("tool.run", async () => {
        throw new Error("x");
      }),
    );
    const { log } = await runOnce({ script: oneCall(), tools: [echo()], plugins: [p] });
    expect(textOf((await log.project()).find((message) => message.role === "tool")!)).toContain("echo:");
  });

  for (const seed of range(10, 70)) {
    it(`tool.after can rewrite results in turn (seed ${seed})`, async () => {
      const a = plugin("a", (api) => api.on("tool.after", (_call, result) => ({ ...result, content: text(`${textOf({ role: "tool", content: result.content, ts: 0 })}+a`) })));
      const b = plugin("b", (api) => api.on("tool.after", (_call, result) => ({ ...result, content: text(`${textOf({ role: "tool", content: result.content, ts: 0 })}+b`) })));
      const { log } = await runOnce({ script: oneCall(), tools: [echo()], plugins: [a, b] });
      expect(textOf((await log.project()).find((message) => message.role === "tool")!)).toMatch(/\+a\+b$/);
    });
  }
});

describe("hooks: turn.end", () => {
  for (const seed of range(10, 80)) {
    it(`appended messages make the run continue (seed ${seed})`, async () => {
      let nudged = false;
      const p = plugin("nudge", (api) =>
        api.on("turn.end", () => {
          if (nudged) return;
          nudged = true;
          return { append: [{ role: "user", content: text(`please continue ${seed}`), ts: 1 }] };
        }),
      );
      const { log, llm } = await runOnce({ script: [{ text: "first" }, { text: "second" }], plugins: [p] });
      expect(llm.requests).toHaveLength(2);
      expect((await log.project()).map(textOf)).toEqual(["go", "first", `please continue ${seed}`, "second"]);
    });
  }

  for (const reason of ["quota", "budget", "approval", "input", "blocked"] as const) {
    for (const variant of range(3)) {
      it(`pause(${reason}) stops the run and is recorded (variant ${variant})`, async () => {
        const p = plugin("limit", (api) => api.on("turn.end", () => ({ pause: reason })));
        const { log, result, events } = await runOnce({ script: [{ text: "a" }, { text: "b" }], plugins: [p] });
        expect(result).toEqual({ reason: "paused", pause: reason });
        expect((await log.branch()).at(-1)).toMatchObject({ type: "paused", reason });
        expect(events.some((event) => event.type === "paused")).toBe(true);
      });
    }
  }

  it("a throwing turn.end handler is skipped", async () => {
    const p = plugin("broken", (api) =>
      api.on("turn.end", () => {
        throw new Error("x");
      }),
    );
    const { result } = await runOnce({ script: [{ text: "a" }], plugins: [p] });
    expect(result.reason).toBe("done");
  });
});

describe("hooks: events and plugins", () => {
  it("event observers see every event, including their own failures being isolated", async () => {
    const seen: string[] = [];
    const watcher = plugin("watcher", (api) => api.on("event", (event) => seen.push(event.type)));
    const broken = plugin("broken", (api) =>
      api.on("event", () => {
        throw new Error("x");
      }),
    );
    const { events } = await runOnce({ script: [{ text: "a" }], plugins: [broken, watcher] });
    // failures of observers are shown to the caller but not fed back to observers
    expect(seen).toEqual(events.filter((event) => event.type !== "plugin").map((event) => event.type));
    expect(events.some((event) => event.type === "plugin")).toBe(true);
  });

  it("plugins can register tools", async () => {
    const extra: Tool = echo("extra");
    const p = plugin("tools", (api) => api.registerTool(extra));
    const { llm } = await runOnce({ script: [{ text: "a" }], plugins: [p] });
    expect(llm.requests[0]?.tools.map((declared) => declared.name)).toEqual(["extra"]);
  });

  it("registering the same tool name twice fails when the kernel is created", () => {
    const p = plugin("dup", (api) => api.registerTool(echo("echo")));
    expect(() => createKernel({ llm: createFauxClient([]), env, system: "s", tools: [echo("echo")], plugins: [p] })).toThrow("already exists");
  });

  it("plugin state survives across runs because setup happens once", async () => {
    let setups = 0;
    const p = plugin("counter", () => {
      setups++;
    });
    const { kernel, log } = setup({ script: [{ text: "a" }, { text: "b" }], plugins: [p] });
    await finish(kernel.run(log, "1"));
    await finish(kernel.run(log, "2"));
    expect(setups).toBe(1);
  });

  it("different logs can run at the same time on one kernel", async () => {
    const llm = createFauxClient((request) => ({ text: `re:${textOf(request.messages.at(-1)!)}` }));
    const kernel = createKernel({ llm, env, system: "s", now: () => 1 });
    const logs = [createMemoryLog(), createMemoryLog()];
    await Promise.all(logs.map((log, index) => finish(kernel.run(log, `q${index}`))));
    expect((await logs[0]!.project()).map(textOf)).toEqual(["q0", "re:q0"]);
    expect((await logs[1]!.project()).map(textOf)).toEqual(["q1", "re:q1"]);
  });
});
