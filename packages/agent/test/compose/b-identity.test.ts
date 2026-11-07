import { describe, expect, it } from "vitest";
import type { Plugin } from "@sakura/kernel";
import { bundle, compose, CompositionError } from "../../src/compose.ts";
import { drain, withAgent } from "./helpers.ts";

const counter = (name: string, hits: string[]): Plugin => ({ name, setup: (api) => api.on("context", () => void hits.push(name)) });
const toolPlugin = (pluginName: string, tool: string): Plugin => ({
  name: pluginName,
  setup: (api) =>
    api.registerTool({ name: tool, description: tool, parameters: { type: "object", properties: {} }, effect: "read", execute: async () => ({ content: [{ type: "text", text: tool }] }) }),
});

describe("B. the same plugin reached twice", () => {
  it("B1 createAgent installs a plugin that is in two bundles once", async () => {
    const hits: string[] = [];
    const shared = counter("shared", hits);
    await withAgent([bundle("one", [shared]), bundle("two", [shared])], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(hits).toEqual(["shared"]);
  });

  it("B2 so its tool is registered once, and creation does not fail on a duplicate", async () => {
    const shared = toolPlugin("t", "dup");
    expect(await withAgent([bundle("one", [shared]), bundle("two", [shared])], [{ text: "ok" }], async () => 1)).toBe(1);
  });

  it("B2b two different plugins registering the same tool still fail, with the kernel's message", async () => {
    await expect(withAgent([toolPlugin("one", "dup"), toolPlugin("two", "dup")], [{ text: "ok" }], async () => 1)).rejects.toThrow(/already exists: dup/);
  });

  it("B3 compose() opens bundles, so a plugin shared by two bundles runs once", async () => {
    const hits: string[] = [];
    const shared = counter("shared", hits);
    const flat = compose([bundle("one", [shared]), bundle("two", [shared, counter("own", hits)])]);
    expect(flat.map((p) => p.name)).toEqual(["shared", "own"]);
    await withAgent(flat, [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(hits).toEqual(["shared", "own"]);
  });

  it("B4 flattening bundles first (listing children, not bundles) lets compose() dedupe", async () => {
    const hits: string[] = [];
    const shared = counter("shared", hits);
    const flat = compose([shared, counter("other", hits), shared]);
    expect(flat.map((p) => p.name)).toEqual(["shared", "other"]);
    await withAgent(flat, [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(hits).toEqual(["shared", "other"]);
  });

  it("B5 two different plugins with the same name are rejected by compose()", () => {
    expect(() => compose([counter("x", []), counter("x", [])])).toThrow(CompositionError);
  });
});
