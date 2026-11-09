import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmRequest, Plugin, Tool } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { corePlugins, createAgent } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-tools-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function drain(handle: { events: AsyncIterable<unknown>; result: Promise<{ reason: string }> }) {
  for await (const _event of handle.events) void _event;
  return handle.result;
}
const isChild = (request: LlmRequest) => request.system.includes("You are a sub-agent");

const status = (calls: string[]): Tool => ({
  name: "project_status",
  description: "Return the status of the sample project.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  effect: "read",
  async execute() {
    calls.push("project_status");
    return { content: [{ type: "text", text: "Build passed." }] };
  },
});

describe("AgentConfig.tools takes tool objects as well as built-in names", () => {
  it("declares a tool you wrote to the model and runs it", async () => {
    const calls: string[] = [];
    const client = createFauxClient((request) => (request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "project_status", args: {}, id: "s" }] }));
    const agent = await createAgent({ model: client, cwd: dir, tools: ["read", status(calls)] });
    expect((await drain(agent.run("how is the build?"))).reason).toBe("done");
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toEqual(["read", "project_status"]);
    expect(calls).toEqual(["project_status"]);
    await agent.close();
  });

  it("works with no built-in tool at all", async () => {
    const client = createFauxClient([{ text: "hi" }]);
    const agent = await createAgent({ model: client, cwd: dir, tools: [status([])] });
    await drain(agent.run("hello"));
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toEqual(["project_status"]);
    await agent.close();
  });
});

describe("a limit on a kind of sub-agent covers every tool, whoever registered it", () => {
  const pluginTool: Plugin = { name: "project-tools", setup: (api) => api.registerTool(status([])) };

  it("a tool from a plugin is left out when the sub-agent was not given its name", async () => {
    const client = createFauxClient((request) =>
      isChild(request) ? { text: "child ok" } : request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x", agent: "reader" }, id: "d" }] },
    );
    const agent = await createAgent({
      model: client,
      cwd: dir,
      plugins: [...corePlugins(), pluginTool],
      subAgents: { agents: [{ name: "reader", description: "reads", tools: ["read"] }] },
    });
    await drain(agent.run("go"));
    expect(client.requests.find(isChild)!.tools.map((tool) => tool.name)).toEqual(["read"]);
    await agent.close();
  });

  it("a tool from a plugin stays when the sub-agent was given its name, and a sub-agent without a limit keeps everything", async () => {
    const client = createFauxClient((request) =>
      isChild(request) ? { text: "child ok" } : request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x", agent: "checker" }, id: "d" }] },
    );
    const agent = await createAgent({
      model: client,
      cwd: dir,
      plugins: [...corePlugins(), pluginTool],
      subAgents: { agents: [{ name: "checker", description: "checks", tools: ["project_status"] }] },
    });
    await drain(agent.run("go"));
    expect(client.requests.find(isChild)!.tools.map((tool) => tool.name)).toEqual(["project_status"]);
    await agent.close();

    const open = createFauxClient((request) =>
      isChild(request) ? { text: "child ok" } : request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x" }, id: "d" }] },
    );
    const free = await createAgent({ model: open, cwd: dir, plugins: [...corePlugins(), pluginTool], subAgents: {} });
    await drain(free.run("go"));
    expect(open.requests.find(isChild)!.tools.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash", "project_status"]);
    await free.close();
  });
});

describe("AgentConfig.rules adds to the generated system prompt", () => {
  const sent = async (config: Partial<Parameters<typeof createAgent>[0]>) => {
    const client = createFauxClient([{ text: "hi" }]);
    const agent = await createAgent({ model: client, cwd: dir, ...config });
    await drain(agent.run("hello"));
    await agent.close();
    return client.requests[0]!.system;
  };

  it("puts each rule in the rules section, after the built-in ones", async () => {
    const system = await sent({ rules: ["Answer in French.", "Never touch the vendor directory."] });
    const rules = system.slice(system.indexOf("<rules>"), system.indexOf("</rules>"));
    expect(rules).toContain("- Answer in French.");
    expect(rules).toContain("- Never touch the vendor directory.");
    expect(rules.indexOf("Keep going until")).toBeLessThan(rules.indexOf("Answer in French."));
  });

  it("changes nothing when there are none, and does not apply to a prompt you replaced", async () => {
    expect(await sent({ rules: [] })).toBe(await sent({}));
    expect(await sent({ system: "Custom prompt.", rules: ["Ignored."] })).toBe("Custom prompt.");
  });

  it("reach a sub-agent that uses the generated prompt", async () => {
    const client = createFauxClient((request) =>
      isChild(request) ? { text: "child ok" } : request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x" }, id: "d" }] },
    );
    const agent = await createAgent({ model: client, cwd: dir, rules: ["Answer in French."], subAgents: {} });
    await drain(agent.run("go"));
    expect(client.requests.find(isChild)!.system).toContain("- Answer in French.");
    await agent.close();
  });
});

describe("AgentConfig.confine keeps the file tools inside the working directory", () => {
  it("a read of a file outside comes back as an error the model can read, and nothing is revealed", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agent-outside-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET-CONTENT");
    await writeFile(join(dir, "ok.txt"), "fine");
    const client = createFauxClient([
      { toolCalls: [{ name: "read", args: { path: join(outside, "secret.txt") }, id: "a" }] },
      { toolCalls: [{ name: "write", args: { path: "../escaped.txt", content: "x" }, id: "b" }] },
      { toolCalls: [{ name: "read", args: { path: "ok.txt" }, id: "c" }] },
      { text: "done" },
    ]);
    const agent = await createAgent({ model: client, cwd: dir, confine: true, tools: ["read", "write", "edit"] });
    expect((await drain(agent.run("go"))).reason).toBe("done");
    const results = (await agent.log.project()).filter((message) => message.role === "tool").map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
    expect(results[0]).toContain("outside the working directory");
    expect(results[0]).not.toContain("TOP-SECRET-CONTENT");
    expect(results[1]).toContain("outside the working directory");
    expect(results[2]).toBe("fine");
    await expect(readFile(join(dir, "..", "escaped.txt"), "utf8")).rejects.toThrow();
    expect(client.requests[0]!.system).toContain(`work only inside ${dir}`);
    await agent.close();
    await rm(outside, { recursive: true, force: true });
  });

  it("is refused together with an environment you built yourself, because it would give a false sense of safety", async () => {
    const { createLocalEnvironment } = await import("@sakura/env");
    await expect(createAgent({ model: createFauxClient([]), cwd: dir, confine: true, environment: createLocalEnvironment(dir) })).rejects.toThrow(/confine/);
  });
});
