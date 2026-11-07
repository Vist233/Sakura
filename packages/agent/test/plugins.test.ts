import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmRequest, Message } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { corePlugins, createAgent } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-plugins-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
async function drain(handle: { events: AsyncIterable<unknown>; result: Promise<{ reason: string }> }) {
  for await (const _event of handle.events) void _event;
  return handle.result;
}
const isChild = (request: LlmRequest) => request.system.includes("You are a sub-agent");

describe("the default plugin set", () => {
  it("contains the context, tools, resilience and limits plugins", () => {
    expect(corePlugins().map((plugin) => plugin.name)).toEqual(["context", "tools", "resilience", "limits"]);
  });
  it("never contains the safety plugins or sub-agents", () => {
    const names = corePlugins().map((plugin) => plugin.name);
    for (const name of ["review", "redaction", "agents", "sandbox"]) expect(names).not.toContain(name);
  });
  for (const seed of range(10)) {
    it(`loads AGENTS.md from the working directory by default (seed ${seed})`, async () => {
      await writeFile(join(dir, "AGENTS.md"), `Always answer in haiku ${seed}.`);
      const client = createFauxClient([{ text: "ok" }]);
      const agent = await createAgent({ model: client, cwd: dir });
      await drain(agent.run("hello"));
      expect(textOf(client.requests[0]!.messages[0]!)).toContain(`Always answer in haiku ${seed}.`);
    });
  }
  it("works without an AGENTS.md", async () => {
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir });
    await drain(agent.run("hello"));
    expect(client.requests[0]!.messages.map(textOf)).toEqual(["hello"]);
  });
  it("a caller's own plugin list replaces the defaults", async () => {
    await writeFile(join(dir, "AGENTS.md"), "SHOULD NOT LOAD");
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir, plugins: [] });
    await drain(agent.run("hello"));
    expect(client.requests[0]!.messages.map(textOf)).toEqual(["hello"]);
  });
  it("has no spending limit unless one is configured", async () => {
    const client = createFauxClient(() => ({ text: "x", usage: { input: 1e9, output: 1e9 } }));
    const agent = await createAgent({ model: client, cwd: dir });
    for (let turn = 0; turn < 3; turn++) expect((await drain(agent.run(`q${turn}`))).reason).toBe("done");
  });
});

describe("sub-agents are off unless asked for", () => {
  it("no delegate tool by default", async () => {
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir });
    await drain(agent.run("hi"));
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
  });
  it("the three tools appear when subAgents is given", async () => {
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir, subAgents: {} });
    await drain(agent.run("hi"));
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash", "delegate", "agent_view", "agent_stop"]);
  });

  for (const seed of range(10, 100)) {
    it(`a sub-agent does a task with the real tools and reports back (seed ${seed})`, async () => {
      const client = createFauxClient((request, index) => {
        void index;
        if (isChild(request)) {
          const last = request.messages.at(-1)!;
          return last.role === "tool" ? { text: `report ${seed}: wrote the file` } : { toolCalls: [{ name: "write", args: { path: `sub${seed}.txt`, content: "from sub-agent" }, id: "w" }] };
        }
        const last = request.messages.at(-1)!;
        return last.role === "tool" ? { text: "all done" } : { toolCalls: [{ name: "delegate", args: { message: "write the file sub.txt" }, id: "d" }] };
      });
      const agent = await createAgent({ model: client, cwd: dir, subAgents: {} });
      expect((await drain(agent.run("delegate this"))).reason).toBe("done");
      const toolResult = (await agent.log.project()).find((message) => message.role === "tool")!;
      expect(textOf(toolResult)).toContain(`report ${seed}: wrote the file`);
      expect(await readdir(dir)).toContain(`sub${seed}.txt`);
      await agent.close();
    });
  }

  it("sub-agents cannot delegate further", async () => {
    const client = createFauxClient((request) =>
      isChild(request) ? { text: "child ok" } : request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x" }, id: "d" }] },
    );
    const agent = await createAgent({ model: client, cwd: dir, subAgents: {} });
    await drain(agent.run("go"));
    const childRequest = client.requests.find(isChild)!;
    expect(childRequest.tools.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
  });

  it("a kind of sub-agent can be limited to some tools and to a number of turns", async () => {
    const client = createFauxClient((request) => {
      if (isChild(request))
        return request.messages.at(-1)!.role === "tool"
          ? { toolCalls: [{ name: "read", args: { path: "a" }, id: `r${request.messages.length}` }] }
          : { toolCalls: [{ name: "read", args: { path: "a" }, id: "r0" }] };
      return request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "loop", agent: "reader" }, id: "d" }] };
    });
    const agent = await createAgent({ model: client, cwd: dir, subAgents: { agents: [{ name: "reader", description: "reads", tools: ["read"], maxTurns: 3 }] } });
    expect((await drain(agent.run("go"))).reason).toBe("done");
    const childRequests = client.requests.filter(isChild);
    expect(childRequests[0]!.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(childRequests).toHaveLength(3);
    expect(textOf((await agent.log.project()).find((message) => message.role === "tool")!)).toContain("ended early");
  });

  it("a kind of sub-agent can use another model from the table", async () => {
    const parentModel = createFauxClient((request) =>
      request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x", agent: "cheap" }, id: "d" }] },
    );
    const cheapModel = createFauxClient([{ text: "from the cheap model" }]);
    const agent = await createAgent({
      model: parentModel,
      cwd: dir,
      subAgents: { agents: [{ name: "cheap", description: "cheap one", model: "small" }], models: { small: cheapModel } },
    });
    await drain(agent.run("go"));
    expect(cheapModel.requests).toHaveLength(1);
    expect(parentModel.requests.every((request) => !request.system.includes("You are a sub-agent"))).toBe(true);
    expect(textOf((await agent.log.project()).find((message) => message.role === "tool")!)).toContain("from the cheap model");
  });

  it("a model name that is not in the table falls back to the parent's model", async () => {
    const client = createFauxClient((request) =>
      isChild(request)
        ? { text: "child on parent model" }
        : request.messages.at(-1)!.role === "tool"
          ? { text: "done" }
          : { toolCalls: [{ name: "delegate", args: { message: "x", agent: "odd" }, id: "d" }] },
    );
    const agent = await createAgent({ model: client, cwd: dir, subAgents: { agents: [{ name: "odd", description: "odd", model: "unknown" }], models: {} } });
    await drain(agent.run("go"));
    expect(client.requests.some(isChild)).toBe(true);
  });

  it("with a session file, sub-agent logs are saved next to it and released on close", async () => {
    const file = join(dir, "sessions", "main.jsonl");
    const client = createFauxClient((request) =>
      isChild(request) ? { text: "child ok" } : request.messages.at(-1)!.role === "tool" ? { text: "done" } : { toolCalls: [{ name: "delegate", args: { message: "x" }, id: "d" }] },
    );
    const agent = await createAgent({ model: client, cwd: dir, sessionFile: file, subAgents: {} });
    await drain(agent.run("go"));
    await agent.close();
    expect(await readdir(join(dir, "sessions", "main", "agents"))).toContain("general-1.jsonl");
    expect((await readdir(join(dir, "sessions", "main", "agents"))).some((name) => name.endsWith(".lock"))).toBe(false);
  });
});

describe("sub-agents and the agent's plugins", () => {
  const probe = (name: string, seen: string[]) => ({
    name,
    setup: (api: { on: (hook: "request", handler: (request: LlmRequest) => void) => void }) => api.on("request", (request) => void seen.push(`${name}:${isChild(request) ? "child" : "parent"}`)),
  });
  async function run(options: { notInherited?: string[] }) {
    const seen: string[] = [];
    const model = createFauxClient((request) =>
      isChild(request) ? { text: "child done" } : request.messages.at(-1)!.role === "tool" ? { text: "parent done" } : { toolCalls: [{ id: "d", name: "delegate", args: { message: "go" } }] },
    );
    const agent = await createAgent({
      model,
      cwd: dir,
      subAgents: options,
      plugins: [...corePlugins(), probe("watcher", seen), probe("limits-like", seen), { name: "agents", setup: () => undefined }],
    });
    await drain(agent.run("start"));
    await agent.close();
    return seen;
  }

  it("shares the plugins that are not on the exclusion list", async () => {
    expect(await run({})).toContain("watcher:child");
  });

  it("does not share a plugin named in notInherited", async () => {
    const seen = await run({ notInherited: ["watcher"] });
    expect(seen).not.toContain("watcher:child");
    expect(seen).toContain("watcher:parent");
    expect(seen).toContain("limits-like:child"); // a custom list replaces the default one
  });
});
