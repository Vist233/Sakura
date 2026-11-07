// Direct tests for small exported helpers that were only exercised indirectly.
import { describe, expect, it } from "vitest";
import { createChannel } from "../src/channel.ts";
import { defaultCompaction } from "../src/compaction.ts";
import { createHookSet } from "../src/hooks.ts";
import { defaultPrompts, fill } from "../src/prompts.ts";
import type { Plugin, Tool } from "../src/index.ts";

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

describe("createChannel", () => {
  it("delivers pushed values in order and finishes after end()", async () => {
    const channel = createChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.end();
    expect(await collect(channel.iterable)).toEqual([1, 2]);
  });
  it("a consumer that is already waiting is woken by a later push", async () => {
    const channel = createChannel<string>();
    const reading = collect(channel.iterable);
    await new Promise((resolve) => setTimeout(resolve, 10));
    channel.push("late");
    channel.end();
    expect(await reading).toEqual(["late"]);
  });
  it("values pushed before anyone reads are not lost", async () => {
    const channel = createChannel<number>();
    for (let index = 0; index < 100; index++) channel.push(index);
    channel.end();
    expect((await collect(channel.iterable)).length).toBe(100);
  });
  it("an empty channel that ends gives nothing", async () => {
    const channel = createChannel<number>();
    channel.end();
    expect(await collect(channel.iterable)).toEqual([]);
  });
  it("a second iteration starts again from the first value", async () => {
    const channel = createChannel<number>();
    channel.push(1);
    channel.end();
    await collect(channel.iterable);
    expect(await collect(channel.iterable)).toEqual([1]);
  });
});

describe("fill", () => {
  it("replaces every occurrence of each {{name}}", () => {
    expect(fill("a {{x}} b {{x}} c {{y}}", { x: "1", y: "2" })).toBe("a 1 b 1 c 2");
  });
  it("leaves unknown placeholders alone and does not treat $ in values specially", () => {
    expect(fill("{{x}} {{z}}", { x: "$&$1" })).toBe("$&$1 {{z}}");
  });
  it("no values, no change", () => {
    expect(fill("{{x}}", {})).toBe("{{x}}");
  });
});

describe("defaults", () => {
  it("every default prompt is a non-empty string", () => {
    for (const [name, value] of Object.entries(defaultPrompts)) {
      expect(typeof value, name).toBe("string");
      expect((value as string).trim().length, name).toBeGreaterThan(0);
    }
  });
  it("the default compaction keeps the reserve smaller than the recent-tokens budget", () => {
    expect(defaultCompaction.reserveTokens).toBeGreaterThan(0);
    expect(defaultCompaction.keepRecentTokens).toBeGreaterThan(defaultCompaction.reserveTokens);
  });
});

describe("createHookSet", () => {
  const tool = (name: string): Tool => ({ name, description: "", parameters: {}, effect: "read", execute: async () => ({ content: [] }) });
  const make = (plugins: Plugin[], builtin: Tool[] = []) =>
    createHookSet(
      plugins,
      builtin,
      () => undefined,
      () => undefined,
    );

  it("starts with the built-in tools and adds the plugins' tools after them", () => {
    const set = make([{ name: "p", setup: (api) => api.registerTool(tool("extra")) }], [tool("base")]);
    expect(set.tools.map((item) => item.name)).toEqual(["base", "extra"]);
  });
  it("a plugin registering a name that exists is an error that names the plugin", () => {
    expect(() => make([{ name: "clash", setup: (api) => api.registerTool(tool("base")) }], [tool("base")])).toThrow(/clash/);
  });
  it("context hooks run in plugin order, each seeing the previous result", () => {
    const add = (label: string): Plugin => ({
      name: label,
      setup: (api) => api.on("context", ({ messages }) => [...messages, { role: "user", content: [{ type: "text", text: label }], ts: 1 }]),
    });
    const result = make([add("a"), add("b")]).context([]);
    expect(result.map((message) => (message.content[0]?.type === "text" ? message.content[0].text : ""))).toEqual(["a", "b"]);
  });
  it("a failing context hook is reported and skipped", () => {
    const reported: string[] = [];
    const set = createHookSet(
      [
        {
          name: "bad",
          setup: (api) =>
            api.on("context", () => {
              throw new Error("nope");
            }),
        },
      ],
      [],
      (plugin, hook) => reported.push(`${plugin}:${hook}`),
      () => undefined,
    );
    expect(set.context([])).toEqual([]);
    expect(reported).toEqual(["bad:context"]);
  });
  it("plugin emit reaches the callback with the plugin's name", () => {
    const seen: Array<[string, unknown]> = [];
    createHookSet(
      [{ name: "emitter", setup: (api) => api.emit({ hello: 1 }) }],
      [],
      () => undefined,
      (name, data) => seen.push([name, data]),
    );
    expect(seen).toEqual([["emitter", { hello: 1 }]]);
  });
});
