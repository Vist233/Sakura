import { describe, expect, it } from "vitest";
import type { Tool, ToolContext, ToolEffect } from "@sakura/kernel";
import { codemodePlugin } from "../src/index.ts";

const make = (name: string, effect: ToolEffect, run: (args: any) => Promise<string> | string, isError = false): Tool => ({
  name,
  description: `tool ${name}`,
  parameters: {},
  effect,
  execute: async (args) => ({ content: [{ type: "text", text: await run(args) }], ...(isError ? { isError } : {}) }),
});
const context = (signal = new AbortController().signal): ToolContext => ({
  env: undefined as never,
  signal,
  callId: "c",
  log: undefined as never,
  notify: () => undefined,
  watch: () => () => undefined,
});

/** Gets the run_code tool out of the plugin by registering it into a collector. */
function codeTool(options: Parameters<typeof codemodePlugin>[0]): Tool {
  let found: Tool | undefined;
  codemodePlugin(options).setup({
    on: () => undefined,
    registerTool: (tool: Tool) => {
      found = tool;
    },
    emit: () => undefined,
  } as never);
  return found!;
}
const runCode = async (code: unknown, options: Partial<Parameters<typeof codemodePlugin>[0]> = {}, ctx = context()) => {
  const result = await codeTool({ catalog: [], ...options }).execute({ code }, ctx);
  return { text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), isError: result.isError === true };
};

describe("codemode: plain scripts", () => {
  const cases: Array<[string, string]> = [
    ["return 1 + 2", "3"],
    ["return 'hi'", "hi"],
    ["console.log('a'); console.log('b'); return 5", "a\nb\n5"],
    ["return [1,2,3].map((n) => n * 2)", "[\n  2,\n  4,\n  6\n]"],
    ["console.log({a: 1})", '{"a":1}'],
    ["", "non-empty"],
  ];
  for (const [code, expected] of cases) {
    it(`${JSON.stringify(code)} -> contains ${JSON.stringify(expected)}`, async () => {
      const result = await runCode(code);
      expect(result.text).toContain(expected);
    });
  }

  it("a script with no output says so", async () => {
    expect((await runCode("let x = 1;")).text).toBe("(no output)");
  });

  it("a syntax error is an error result", async () => {
    const result = await runCode("return (");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Script error");
  });

  it("a thrown error is reported with what was printed before it", async () => {
    const result = await runCode("console.log('before'); throw new Error('bad thing')");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("before");
    expect(result.text).toContain("bad thing");
  });
});

describe("codemode: the sandbox has nothing but the tools", () => {
  for (const probe of ["process", "require", "fetch", "setTimeout", "XMLHttpRequest", "Buffer", "globalThis.window"]) {
    it(`${probe} is not available`, async () => {
      const result = await runCode(`return typeof (${probe})`).catch(() => ({ text: "undefined", isError: false }));
      expect(result.text === "undefined" || result.isError).toBe(true);
    });
  }

  it("importing a module fails", async () => {
    const result = await runCode("const fs = await import('fs'); return typeof fs.readFileSync");
    expect(result.isError).toBe(true);
  });

  it("an infinite loop is stopped by the time limit", async () => {
    const started = Date.now();
    const result = await runCode("while (true) {}", { timeoutMs: 300 });
    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a runaway allocation hits the memory limit", async () => {
    const result = await runCode("const a = []; while (true) a.push(new Array(100000).fill(1));", { memoryBytes: 8 * 1024 * 1024, timeoutMs: 5000 });
    expect(result.isError).toBe(true);
  });

  it("each run starts clean: globals do not leak between runs", async () => {
    await runCode("globalThis.secret = 42");
    expect((await runCode("return typeof secret")).text).toBe("undefined");
  });
});

describe("codemode: calling tools", () => {
  const add = make("add", "read", (args) => String(args.a + args.b));
  const upper = make("upper", "read", (args) => String(args.text).toUpperCase());
  const writer = make("write_thing", "write", () => "written");
  const failing = make("failing", "read", () => "no luck", true);
  const throwing = make("throwing", "read", () => {
    throw new Error("kaboom");
  });

  it("calls a tool and gets its text", async () => {
    expect((await runCode("return await tools.add({a: 2, b: 3})", { catalog: [add] })).text).toBe("5");
  });

  it("combines several calls in one script", async () => {
    const code = "const x = await tools.add({a: 1, b: 2}); const y = await tools.upper({text: 'v' + x}); return y;";
    expect((await runCode(code, { catalog: [add, upper] })).text).toBe("V3");
  });

  it("parallel calls with Promise.all", async () => {
    const result = await runCode("return (await Promise.all([1,2,3,4].map((n) => tools.add({a: n, b: n})))).join(',')", { catalog: [add] });
    expect(result.text).toBe("2,4,6,8");
  });

  it("works in a loop of calls", async () => {
    const result = await runCode("let total = 0; for (let i = 0; i < 20; i++) total += Number(await tools.add({a: i, b: 0})); return total", { catalog: [add] });
    expect(result.text).toBe("190");
  });

  it("an unknown tool throws inside the script", async () => {
    const result = await runCode("try { await tools.nope({}); } catch (e) { return 'caught: ' + e.message; }", { catalog: [add] });
    expect(result.text).toContain("caught: no tool named 'nope'");
  });

  it("every effect is allowed unless the list is narrowed", async () => {
    const result = await runCode("return await tools.write_thing({})", { catalog: [writer] });
    expect(result.text).toBe("written");
  });

  it("a tool with an effect that is not allowed cannot be called", async () => {
    const result = await runCode("try { await tools.write_thing({}); } catch (e) { return e.message; }", { catalog: [writer], allowEffects: ["read"] });
    expect(result.text).toContain("cannot be called from a script");
  });

  it("allowEffects can open it up", async () => {
    const result = await runCode("return await tools.write_thing({})", { catalog: [writer], allowEffects: ["read", "write"] });
    expect(result.text).toBe("written");
  });

  it("an error result of a tool becomes an exception in the script", async () => {
    const result = await runCode("try { await tools.failing({}); } catch (e) { return e.message; }", { catalog: [failing] });
    expect(result.text).toBe("no luck");
  });

  it("a tool that throws becomes an exception in the script", async () => {
    const result = await runCode("try { await tools.throwing({}); } catch (e) { return e.message; }", { catalog: [throwing] });
    expect(result.text).toBe("kaboom");
  });

  it("an uncaught tool error ends the script with an error result", async () => {
    const result = await runCode("await tools.failing({})", { catalog: [failing] });
    expect(result.isError).toBe(true);
  });

  it("the tool gets the same context as a normal call", async () => {
    let seen: string | undefined;
    const spy = make("spy", "read", () => "x");
    spy.execute = async (_args, ctx) => {
      seen = ctx.callId;
      return { content: [{ type: "text", text: "x" }] };
    };
    await runCode("await tools.spy({})", { catalog: [spy] });
    expect(seen).toBe("c");
  });

  it("a slow tool that outlives the time limit stops the script", async () => {
    const slow = make("slow", "read", () => new Promise((resolve) => setTimeout(() => resolve("late"), 2000)));
    const result = await runCode("return await tools.slow({})", { catalog: [slow], timeoutMs: 300 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("longer than");
  });

  it("cancelling the run stops the script", async () => {
    const controller = new AbortController();
    const slow = make("slow", "read", () => new Promise((resolve) => setTimeout(() => resolve("late"), 2000)));
    setTimeout(() => controller.abort(), 100);
    const result = await runCode("return await tools.slow({})", { catalog: [slow] }, context(controller.signal));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("cancelled");
  });
});

describe("codemode: output size", () => {
  it("long output keeps the head and the tail", async () => {
    const result = await runCode("return 'a'.repeat(50000) + 'END'", { maxOutputChars: 1000 });
    expect(result.text.length).toBeLessThan(1200);
    expect(result.text).toContain("characters omitted");
    expect(result.text.endsWith("END")).toBe(true);
  });

  it("the description lists the tools the script can use", () => {
    const tool = codeTool({ catalog: [make("alpha", "read", () => ""), make("beta", "read", () => "")] });
    expect(tool.description).toContain("alpha, beta");
  });
});

describe("codemode: a script that ends before its tool calls do", () => {
  it("does not crash the process when a late tool call settles after the sandbox is gone", async () => {
    const slow = make("slow", "read", () => new Promise((resolve) => setTimeout(() => resolve("late"), 150)));
    // the script does not wait for the call, so the sandbox is disposed while the call is still running
    const result = await runCode("tools.slow({}); return 'left without waiting'", { catalog: [slow] });
    expect(result.text).toBe("left without waiting");
    await new Promise((resolve) => setTimeout(resolve, 400)); // an unhandled error would fail the run here
  });
});

describe("codemode: authorize is asked before each call a script makes", () => {
  const add = make("add", "read", (args) => String(args.a + args.b));
  const wipe = make("wipe", "write", () => "wiped");

  it("a call that is allowed runs, and the question carries the call and a way to find the tool", async () => {
    const asked: Array<{ id: string; name: string; args: unknown; found: string | undefined }> = [];
    const authorize = async (call: { id: string; name: string; args: unknown }, ctx: { tool(name: string): Tool | undefined }) => {
      asked.push({ ...call, found: ctx.tool("add")?.name });
      return { kind: "allow" as const };
    };
    const result = await runCode("return await tools.add({a: 2, b: 3})", { catalog: [add], authorize });
    expect(result).toEqual({ text: "5", isError: false });
    expect(asked).toEqual([{ id: "c/1", name: "add", args: { a: 2, b: 3 }, found: "add" }]);
  });

  it("a refused call does not run; the reason is raised inside the script", async () => {
    let ran = false;
    const spy = make("spy", "read", () => {
      ran = true;
      return "ran";
    });
    const result = await runCode("try { await tools.spy({}) } catch (e) { return 'caught: ' + e.message }", { catalog: [spy], authorize: async () => ({ kind: "deny", reason: "not today" }) });
    expect(result).toEqual({ text: "caught: not today", isError: false });
    expect(ran).toBe(false);
  });

  it("every call is asked about, with its own id", async () => {
    const ids: string[] = [];
    await runCode("await tools.add({a: 1, b: 1}); await tools.add({a: 2, b: 2}); return 'x'", {
      catalog: [add],
      authorize: async (call) => {
        ids.push(call.id);
        return { kind: "allow" };
      },
    });
    expect(ids).toEqual(["c/1", "c/2"]);
  });

  it("is not asked about a tool that does not exist or whose effect is not allowed", async () => {
    let asked = 0;
    const authorize = async () => {
      asked++;
      return { kind: "allow" as const };
    };
    const result = await runCode("const out = []; for (const name of ['nope', 'wipe']) { try { await tools[name]({}) } catch (e) { out.push(e.message) } } return out", {
      catalog: [wipe],
      allowEffects: ["read"],
      authorize,
    });
    expect(result.text).toContain("no tool named 'nope'");
    expect(result.text).toContain("cannot be called from a script");
    expect(asked).toBe(0);
  });

  it("a wide effect list does not skip the question", async () => {
    let ran = false;
    const risky = make("risky", "write", () => {
      ran = true;
      return "done";
    });
    const result = await runCode("return await tools.risky({})", { catalog: [risky], authorize: async () => ({ kind: "deny", reason: "no writes" }) });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no writes");
    expect(ran).toBe(false);
  });

  it("an authorizer that throws refuses the call", async () => {
    const result = await runCode("return await tools.add({a: 1, b: 1})", {
      catalog: [add],
      authorize: async () => {
        throw new Error("reviewer down");
      },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("reviewer down");
  });

  it("without authorize nothing is asked and calls run as before", async () => {
    expect((await runCode("return await tools.add({a: 1, b: 2})", { catalog: [add] })).text).toBe("3");
  });
});

describe("codemode: exact wording and limits", () => {
  const add = make("add", "read", (args) => String(args.a + args.b));

  it("a successful result has no isError key", async () => {
    const result = await codeTool({ catalog: [] }).execute({ code: "return 'x'" }, context());
    expect(result).toEqual({ content: [{ type: "text", text: "x" }] });
  });

  it("output of exactly the limit is kept, one more is cut in the middle", async () => {
    expect((await runCode("return 'abcdefghij'", { maxOutputChars: 10 })).text).toBe("abcdefghij");
    expect((await runCode("return 'abcdefghijk'", { maxOutputChars: 10 })).text).toBe("abcde\n[... 1 characters omitted ...]\nghijk");
  });

  it("the time limit is named in seconds", async () => {
    const stuck = make("stuck", "read", () => new Promise<string>(() => undefined));
    const result = await runCode("return await tools.stuck({})", { catalog: [stuck], timeoutMs: 1000 });
    expect(result).toEqual({ text: "The script took longer than 1 seconds and was stopped.", isError: true });
  });

  it("a tool result with parts that are not text shows them as [type], joined by newlines", async () => {
    const mixed: Tool = {
      name: "mixed",
      description: "",
      parameters: {},
      effect: "read",
      execute: async () => ({
        content: [
          { type: "image", mediaType: "image/png", ref: "r" },
          { type: "text", text: "caption" },
        ],
      }),
    };
    expect((await runCode("return await tools.mixed({})", { catalog: [mixed] })).text).toBe("[image]\ncaption");
  });

  it("the tool's arguments arrive as the script gave them, and a call without arguments gets an empty object", async () => {
    const echo = make("echo", "read", (args) => JSON.stringify(args));
    expect((await runCode("return [await tools.echo({a: [1, {b: 2}]}), await tools.echo()].join('|')", { catalog: [echo] })).text).toBe('{"a":[1,{"b":2}]}|{}');
    expect((await runCode("return await tools.add({a: 1, b: 2})", { catalog: [add] })).text).toBe("3");
  });

  it("ordinary recursion works; endless recursion ends the script with an error and leaves the sandbox usable", async () => {
    expect((await runCode("const f = (n) => n === 0 ? 0 : 1 + f(n - 1); return f(1000)")).text).toBe("1000");
    const endless = await runCode("const f = () => f(); f()");
    expect(endless.isError).toBe(true);
    expect(endless.text).toContain("stack overflow");
    expect((await runCode("return 'still works'")).text).toBe("still works"); // the module was not left aborted
  });

  it("console.log prints strings as they are and other values as JSON, joined by spaces", async () => {
    expect((await runCode("console.log('a', {b: 1}, [2], 3, null); return undefined")).text).toBe('a {"b":1} [2] 3 null');
  });
});

describe("codemode: how an error is written", () => {
  it("an Error shows its name and message; a plain object its message; anything else as it is", async () => {
    expect((await runCode("null.x")).text).toMatch(/^Script error: TypeError: /);
    expect((await runCode("throw new RangeError('too far')")).text).toBe("Script error: RangeError: too far");
    expect((await runCode("throw {message: 'only a message'}")).text).toBe("Script error: only a message");
    expect((await runCode("throw 'a string'")).text).toBe("Script error: a string");
    expect((await runCode("throw 42")).text).toBe("Script error: 42");
    expect((await runCode("throw null")).text).toBe("Script error: null");
  });
  it("a syntax error is reported the same way", async () => {
    const result = await runCode("return (");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Script error: SyntaxError: /);
  });
  it("what was printed comes before the error", async () => {
    expect((await runCode("console.log('one'); console.log('two'); throw new Error('x')")).text).toBe("one\ntwo\nScript error: Error: x");
  });
});
