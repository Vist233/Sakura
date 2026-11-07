import { describe, expect, it } from "vitest";
import type { Event, Plugin } from "@sakura/kernel";
import { bundle } from "../../src/compose.ts";
import { drain, withAgent } from "./helpers.ts";

describe("F. how plugins talk to each other", () => {
  it("F1 a plugin's emit() reaches another plugin's event hook (a loose, name-tagged channel)", async () => {
    const received: Array<{ name: string; data: unknown }> = [];
    const sender: Plugin = { name: "sender", setup: (api) => api.on("context", () => api.emit({ hello: 1 })) };
    const listener: Plugin = {
      name: "listener",
      setup: (api) =>
        api.on("event", (e: Event) => {
          if (e.type === "plugin") received.push({ name: e.name, data: e.data });
        }),
    };
    await withAgent([bundle("b", [sender, listener])], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(received).toContainEqual({ name: "sender", data: { hello: 1 } }); // tagged with the child's name, not the bundle's
  });

  it("F2 through the log: one plugin writes a custom entry, another reads it in prepare", async () => {
    let read: unknown;
    const writer: Plugin = { name: "writer", setup() {}, prepare: async ({ log }) => void (await log.append({ type: "custom", customType: "note", data: { n: 7 } })) };
    const reader: Plugin = {
      name: "reader",
      setup() {},
      prepare: async ({ log }) => {
        const entry = (await log.branch()).find((e) => e.type === "custom" && e.customType === "note");
        read = entry && entry.type === "custom" ? entry.data : undefined;
      },
    };
    await withAgent([bundle("b", [writer, reader])], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(read).toEqual({ n: 7 });
  });

  it("F3 shared service object created once and handed to both plugins explicitly", async () => {
    const service = { calls: [] as string[] };
    const mk = (n: string): Plugin => ({ name: n, setup: (api) => api.on("context", () => void service.calls.push(n)) });
    await withAgent([bundle("b", [mk("x"), mk("y")])], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(service.calls).toEqual(["x", "y"]);
  });

  it("F4 a plugin cannot call another plugin's tool through the kernel (ToolContext has no way to)", async () => {
    // The only public path is to hold a reference to the other plugin's tool object and call execute yourself.
    // That skips tool.before / tool.run / tool.after, so permission and review plugins never see the call.
    const seen: string[] = [];
    const inner = {
      name: "inner",
      description: "i",
      parameters: { type: "object", properties: {} },
      effect: "write" as const,
      execute: async (_args: unknown, _ctx: unknown) => ({ content: [{ type: "text" as const, text: "INNER" }] }),
    };
    const outer: Plugin = {
      name: "outer",
      setup: (api) =>
        api.registerTool({
          name: "outer",
          description: "o",
          parameters: { type: "object", properties: {} },
          effect: "read",
          execute: async (_a, ctx) => inner.execute({}, ctx),
        }),
    };
    const watcher: Plugin = { name: "watcher", setup: (api) => api.on("tool.before", (c) => void seen.push(c.name)) };
    await withAgent([bundle("b", [outer, watcher])], [{ toolCalls: [{ name: "outer", args: {} }] }, { text: "done" }], async (agent) => void (await drain(agent.run("go"))));
    expect(seen).toEqual(["outer"]); // "inner" never passed through the hooks: the same gap as codemode's nested calls
  });
});
