// Exact behaviour of the sub-agent tools (added after mutation testing).
import { describe, expect, it } from "vitest";
import { createKernel, ProviderError } from "@sakura/kernel";
import type { Environment, Tool, ToolContext } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import type { FauxScript } from "@sakura/testing";
import { agentsPlugin } from "../src/index.ts";
import type { AgentDefinition } from "../src/index.ts";

const env = { cwd: "/w", resolve: (p: string) => p, dispose: async () => undefined } as unknown as Environment;
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");

/** The plugin's three tools, set up against a recording API, with children that answer from `child` scripts. */
function tools(options: { child?: (index: number) => FauxScript; agents?: AgentDefinition[]; maxRunning?: number; maxRegistered?: number } = {}) {
  const found: Record<string, Tool> = {};
  const created: Array<{ definition: AgentDefinition; model?: string; maxTurns?: number }> = [];
  agentsPlugin({
    agents: options.agents ?? [],
    ...(options.maxRunning !== undefined ? { maxRunning: options.maxRunning } : {}),
    ...(options.maxRegistered !== undefined ? { maxRegistered: options.maxRegistered } : {}),
    createChild: (request) => {
      created.push(request);
      return createKernel({ llm: createFauxClient(options.child?.(created.length - 1) ?? [{ text: "child done" }]), env, system: "child", compaction: false, now: () => 1 });
    },
  }).setup({
    on: () => undefined,
    registerTool: (tool: Tool) => {
      found[tool.name] = tool;
    },
    emit: () => undefined,
  } as never);
  const log = createMemoryLog();
  const context = (signal = new AbortController().signal): ToolContext => ({ env, signal, callId: "c", log, notify: () => undefined, watch: () => () => undefined });
  const run = (name: string, args: unknown, signal?: AbortSignal) => found[name]!.execute(args, context(signal));
  return { found, created, run, log };
}

describe("tool definitions", () => {
  const { found } = tools();
  it("three tools with the right effects", () => {
    expect(Object.keys(found).sort()).toEqual(["agent_stop", "agent_view", "delegate"]);
    expect(found.delegate).toMatchObject({ effect: "exec", replay: "never" });
    expect(found.agent_view!.effect).toBe("read");
    expect(found.agent_stop!.effect).toBe("exec");
  });
  it("delegate takes a required message and optional agent, to, background and max_turns", () => {
    const parameters = found.delegate!.parameters as { required: string[]; properties: Record<string, { type: string }> };
    expect(parameters.required).toEqual(["message"]);
    expect(
      Object.entries(parameters.properties)
        .map(([name, value]) => `${name}:${value.type}`)
        .sort(),
    ).toEqual(["agent:string", "background:boolean", "max_turns:integer", "message:string", "to:string"]);
  });
  it("agent_view takes optional id, last, thinking and wait_seconds; agent_stop requires an id", () => {
    const view = found.agent_view!.parameters as { properties: Record<string, { type: string }>; required?: string[] };
    expect(
      Object.entries(view.properties)
        .map(([name, value]) => `${name}:${value.type}`)
        .sort(),
    ).toEqual(["id:string", "last:integer", "thinking:boolean", "wait_seconds:number"]);
    expect(view.required).toBeUndefined();
    expect((found.agent_stop!.parameters as { required: string[] }).required).toEqual(["id"]);
  });
  it("the delegate description lists the kinds of sub-agent", () => {
    const withKinds = tools({ agents: [{ name: "reader", description: "reads files" }] });
    const described = (withKinds.found.delegate!.parameters as { properties: { agent: { description: string } } }).properties.agent.description;
    expect(described).toContain("general");
    expect(described).toContain("reader (reads files)");
  });
});

describe("delegate: input and limits", () => {
  it("an empty or missing message is an error", async () => {
    const t = tools();
    for (const args of [{}, { message: "" }, { message: "   " }, { message: 5 }, null]) {
      const result = await t.run("delegate", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result)).toContain("non-empty string");
    }
  });
  it("an unknown kind of sub-agent names the kinds there are", async () => {
    const t = tools({ agents: [{ name: "reader", description: "r" }] });
    const result = await t.run("delegate", { message: "x", agent: "wizard" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown kind of sub-agent 'wizard'. Available: general, reader.");
  });
  it("an unknown id for a follow-up is an error", async () => {
    const result = await tools().run("delegate", { message: "x", to: "general-9" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("no sub-agent with id 'general-9'");
  });
  it("at most maxRegistered sub-agents exist, and at most maxRunning run at once", async () => {
    const registered = tools({ maxRegistered: 2 });
    await registered.run("delegate", { message: "a" });
    await registered.run("delegate", { message: "b" });
    const third = await registered.run("delegate", { message: "c" });
    expect(third.isError).toBe(true);
    expect(text(third)).toContain("There are already 2 sub-agents");

    const running = tools({ maxRunning: 1, child: () => [{ hang: true }] });
    await running.run("delegate", { message: "a", background: true });
    const second = await running.run("delegate", { message: "b", background: true });
    expect(second.isError).toBe(true);
    expect(text(second)).toBe("Too many sub-agents are running (1). Wait for one to finish or stop one.");
    await running.run("agent_stop", { id: "general-1" });
  });
  it("ids count up per kind of plugin instance: general-1, general-2", async () => {
    const t = tools();
    expect(text(await t.run("delegate", { message: "a" }))).toContain("general-1");
    expect(text(await t.run("delegate", { message: "b" }))).toContain("general-2");
  });
  it("the kind's model and max_turns reach createChild; a call's max_turns beats the kind's", async () => {
    const t = tools({ agents: [{ name: "fast", description: "f", model: "small", maxTurns: 7 }] });
    await t.run("delegate", { message: "a", agent: "fast" });
    await t.run("delegate", { message: "b", agent: "fast", max_turns: 2 });
    await t.run("delegate", { message: "c" });
    expect(t.created[0]).toMatchObject({ model: "small", maxTurns: 7 });
    expect(t.created[1]).toMatchObject({ model: "small", maxTurns: 2 });
    expect(t.created[2]!.model).toBeUndefined();
    expect(t.created[2]!.maxTurns).toBeUndefined();
  });
  it("a follow-up to an idle sub-agent runs it again; to a running one it is queued", async () => {
    const idle = tools({ child: () => [{ text: "first" }, { text: "second" }] });
    await idle.run("delegate", { message: "one" });
    expect(text(await idle.run("delegate", { message: "two", to: "general-1" }))).toContain("second");

    const busy = tools({ child: () => [{ hang: true }] });
    await busy.run("delegate", { message: "one", background: true });
    expect(text(await busy.run("delegate", { message: "two", to: "general-1" }))).toContain("still working; your message was queued");
    await busy.run("agent_stop", { id: "general-1" });
  });
});

describe("delegate: the end of a sub-agent", () => {
  it("done is reported plainly with the final answer; a failure says it ended early with the reason", async () => {
    const ok = await tools({ child: () => [{ text: "the answer" }] }).run("delegate", { message: "x" });
    expect(text(ok)).toBe("Sub-agent general-1 finished.\n\nthe answer");
    expect(ok.isError).toBeUndefined();
    const failed = await tools({ child: () => [{ error: new ProviderError("auth", "bad key") }] }).run("delegate", { message: "x" });
    expect(text(failed)).toContain("[The sub-agent ended early:");
    expect(failed.isError).toBe(true);
  });
  it("a sub-agent that is cancelled is shown as stopped, and its status line says so in agent_view", async () => {
    const t = tools({ child: () => [{ hang: true }] });
    await t.run("delegate", { message: "x", background: true });
    await t.run("agent_stop", { id: "general-1" });
    expect(text(await t.run("agent_view", {}))).toMatch(/^general-1 \(general\): stopped, \d+ turns, \d+ tokens$/);
  });
  it("cancelling the parent's call while it waits stops the sub-agent", async () => {
    const t = tools({ child: () => [{ hang: true }] });
    const controller = new AbortController();
    const pending = t.run("delegate", { message: "x" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const result = await pending;
    expect(text(result)).toContain("ended early");
  });
});

describe("agent_view and agent_stop", () => {
  it("lists nothing, then every sub-agent with status, turns and tokens", async () => {
    const t = tools({ child: (index) => [{ text: `done ${index}`, usage: { input: 10, output: 5 } }] });
    expect(text(await t.run("agent_view", {}))).toBe("There are no sub-agents.");
    await t.run("delegate", { message: "a" });
    await t.run("delegate", { message: "b" });
    expect(text(await t.run("agent_view", {})).split("\n")).toEqual(["general-1 (general): idle, 1 turns, 15 tokens", "general-2 (general): idle, 1 turns, 15 tokens"]);
  });
  it("an unknown id is an error", async () => {
    const result = await tools().run("agent_view", { id: "nope" });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("There is no sub-agent with id 'nope'.");
  });
  it("wait_seconds waits for a running sub-agent to finish, but not longer than asked, and a zero or missing wait does not wait", async () => {
    const quick = tools({ child: () => [{ text: "soon" }] });
    await quick.run("delegate", { message: "x", background: true });
    const started = Date.now();
    expect(text(await quick.run("agent_view", { id: "general-1", wait_seconds: 5 }))).toContain("idle");
    expect(Date.now() - started).toBeLessThan(2000);

    const slow = tools({ child: () => [{ hang: true }] });
    await slow.run("delegate", { message: "x", background: true });
    const t0 = Date.now();
    expect(text(await slow.run("agent_view", { id: "general-1", wait_seconds: 0.2 }))).toContain("running");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    const t1 = Date.now();
    await slow.run("agent_view", { id: "general-1", wait_seconds: 0 });
    await slow.run("agent_view", { id: "general-1" });
    expect(Date.now() - t1).toBeLessThan(150);
    await slow.run("agent_stop", { id: "general-1" });
  });
  it("cancelling the viewer's call ends the wait", async () => {
    const t = tools({ child: () => [{ hang: true }] });
    await t.run("delegate", { message: "x", background: true });
    const controller = new AbortController();
    const started = Date.now();
    const pending = t.run("agent_view", { id: "general-1", wait_seconds: 30 }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    await t.run("agent_stop", { id: "general-1" });
  });
  it("last limits the steps shown (default 10); reasoning is not shown unless asked", async () => {
    const t = tools({ child: () => [{ text: "step", reasoning: "private thoughts" }] });
    await t.run("delegate", { message: "x" });
    expect(text(await t.run("agent_view", { id: "general-1" }))).not.toContain("private thoughts");
    expect(text(await t.run("agent_view", { id: "general-1", last: 1 }))).not.toContain("user: x");
    expect(text(await t.run("agent_view", { id: "general-1", last: 0 }))).toContain("user: x"); // zero means the default
    expect(text(await t.run("agent_view", { id: "general-1", last: -3 }))).toContain("user: x");
  });
  it("agent_stop needs a string id, knows unknown ids, and says when nothing was running", async () => {
    const t = tools();
    for (const args of [{}, { id: 5 }, null]) expect(text(await t.run("agent_stop", args))).toBe("'id' must be a string.");
    expect(text(await t.run("agent_stop", { id: "ghost" }))).toBe("There is no sub-agent with id 'ghost'.");
    await t.run("delegate", { message: "x" });
    expect(text(await t.run("agent_stop", { id: "general-1" }))).toBe("Sub-agent general-1 is not running (idle).");
  });
  it("stopping a running one says so and waits until it has stopped", async () => {
    const t = tools({ child: () => [{ hang: true }] });
    await t.run("delegate", { message: "x", background: true });
    expect(text(await t.run("agent_stop", { id: "general-1" }))).toBe("Stopped sub-agent general-1.");
  });
  it("a sub-agent that failed shows the failure as a note", async () => {
    const t = tools({ child: () => [{ error: new ProviderError("quota", "no credit") }] });
    await t.run("delegate", { message: "x" });
    expect(text(await t.run("agent_view", { id: "general-1" }))).toMatch(/failed[\s\S]*note: .*no credit/);
  });
});

describe("plugin identity", () => {
  it("is called agents and says what it compensates for", () => {
    const plugin = agentsPlugin({
      createChild: () => {
        throw new Error("n/a");
      },
    });
    expect(plugin.name).toBe("agents");
    expect(plugin.compensates).toContain("context");
  });
});
