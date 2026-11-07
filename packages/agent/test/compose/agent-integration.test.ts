// How createAgent uses bundle() and compose(): it opens bundles, installs each plugin once, orders by requirements and fails before any run.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LlmRequest, Message, Plugin } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { bundle, CompositionError, corePlugins, createAgent } from "../../src/index.ts";
import type { Composable } from "../../src/index.ts";
import { drain, withAgent } from "./helpers.ts";

const server = fileURLToPath(new URL("../../../plugins/toolset/test/fake-mcp-server.mjs", import.meta.url));
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const isChild = (request: LlmRequest) => request.system.includes("You are a sub-agent");

describe("createAgent and composed plugins", () => {
  it("fails at creation, naming both sides, when a requirement is missing", async () => {
    const needy: Composable = { name: "needy", requires: ["review"], setup: () => undefined };
    await expect(createAgent({ model: createFauxClient([]), plugins: [needy] })).rejects.toThrow("plugin 'needy' requires 'review', which nothing provides");
  });

  it("fails at creation when two different plugins share a name", async () => {
    const one: Plugin = { name: "same", setup: () => undefined };
    const two: Plugin = { name: "same", setup: () => undefined };
    await expect(createAgent({ model: createFauxClient([]), plugins: [one, two] })).rejects.toBeInstanceOf(CompositionError);
  });

  it("puts a required plugin first, wherever it was listed", async () => {
    const seen: string[] = [];
    const note = (name: string): Composable => ({ name, setup: (api) => api.on("context", () => void seen.push(name)) });
    const b: Composable = { ...note("b"), requires: ["a"] };
    await withAgent([b, note("a")], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(seen).toEqual(["a", "b"]);
  });

  it("the default plugin set is a plugin list like any other and can sit inside a bundle", async () => {
    await withAgent([bundle("defaults", corePlugins())], [{ text: "ok" }], async (agent) => {
      expect((await drain(agent.run("hi"))).reason).toBe("done");
    });
  });
});

describe("a bundle that holds review keeps it working everywhere", () => {
  const gate = (asked: string[]) => ({ name: "gate", setup: () => undefined, authorize: async (call: { name: string }) => (asked.push(call.name), { kind: "deny" as const, reason: "gate says no" }) });

  it("codemode finds an authorize that is inside a bundle", async () => {
    const asked: string[] = [];
    const script = [
      { toolCalls: [{ name: "run_code", args: { code: "try { return await tools.mcp__fake__echo({text: 'hi'}) } catch (e) { return 'refused: ' + e.message }" }, id: "r" }] },
      { text: "ok" },
    ];
    const agent = await createAgent({
      model: createFauxClient(script),
      cwd: process.cwd(),
      plugins: [...corePlugins(), bundle("safety", [gate(asked)])],
      mcp: { servers: { fake: { command: process.execPath, args: [server] } }, expose: "codemode" },
    });
    await agent.run("go").result;
    const results = (await agent.log.project()).filter((message) => message.role === "tool").map(textOf);
    await agent.close();
    expect(results).toEqual(["refused: gate says no"]);
    expect(asked).toEqual(["mcp__fake__echo"]);
  });

  it("sub-agents inherit the plugins inside a bundle, and notInherited names the plugin, not the bundle", async () => {
    const seen: string[] = [];
    const watcher: Plugin = { name: "watcher", setup: (api) => api.on("request", (request: LlmRequest) => void seen.push(isChild(request) ? "child" : "parent")) };
    const script = (request: LlmRequest) =>
      isChild(request) ? { text: "child done" } : request.messages.at(-1)!.role === "tool" ? { text: "parent done" } : { toolCalls: [{ id: "d", name: "delegate", args: { message: "go" } }] };
    const run = async (notInherited?: string[]) => {
      seen.length = 0;
      const agent = await createAgent({
        model: createFauxClient(script),
        cwd: process.cwd(),
        subAgents: notInherited ? { notInherited } : {},
        plugins: [...corePlugins(), bundle("suite", [watcher])],
      });
      await drain(agent.run("start"));
      await agent.close();
      return [...seen];
    };
    expect(await run()).toContain("child");
    expect(await run(["agents", "limits", "context", "tools", "watcher"])).not.toContain("child");
    expect(await run(["suite"])).toContain("child"); // the bundle's own name is not a plugin that was installed
  });
});
