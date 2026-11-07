import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFauxClient } from "@sakura/testing";
import type { FauxScript } from "@sakura/testing";
import type { Message, Plugin } from "@sakura/kernel";
import { createAgent } from "../src/index.ts";

const server = fileURLToPath(new URL("../../plugins/toolset/test/fake-mcp-server.mjs", import.meta.url));
const good = { command: process.execPath, args: [server] };
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

async function drive(script: FauxScript, mcp: NonNullable<Parameters<typeof createAgent>[0]["mcp"]>) {
  const llm = createFauxClient(script);
  const agent = await createAgent({ model: llm, cwd: process.cwd(), mcp });
  await agent.run("go").result;
  const results = (await agent.log.project()).filter((message) => message.role === "tool").map(textOf);
  const declared = llm.requests[0]!.tools.map((tool) => tool.name);
  await agent.close();
  return { agent, declared, results };
}

describe("agent with MCP servers", () => {
  it("direct exposure declares every MCP tool and runs them", async () => {
    const { declared, results } = await drive([{ toolCalls: [{ name: "mcp__fake__echo", args: { text: "hi" }, id: "e" }] }, { text: "ok" }], { servers: { fake: good }, expose: "direct" });
    expect(declared).toContain("mcp__fake__echo");
    expect(declared).toContain("bash");
    expect(results).toEqual(["echo: hi"]);
  });

  it("search exposure declares only tool_search and tool_call besides the built-ins", async () => {
    const { declared, results } = await drive(
      [
        { toolCalls: [{ name: "tool_search", args: { query: "echo text" }, id: "s" }] },
        { toolCalls: [{ name: "tool_call", args: { name: "mcp__fake__echo", args: { text: "yo" } }, id: "c" }] },
        { text: "ok" },
      ],
      { servers: { fake: good }, expose: "search" },
    );
    expect(declared).toContain("tool_search");
    expect(declared.some((name) => name.startsWith("mcp__"))).toBe(false);
    expect(results[0]).toContain("mcp__fake__echo");
    expect(results[1]).toBe("echo: yo");
  });

  it("codemode exposure lets a script call read-only MCP tools", async () => {
    const { declared, results } = await drive([{ toolCalls: [{ name: "run_code", args: { code: "return await tools.mcp__fake__echo({text: 'from script'})" }, id: "r" }] }, { text: "ok" }], {
      servers: { fake: good },
      expose: "codemode",
    });
    expect(declared).toContain("run_code");
    expect(results).toEqual(["echo: from script"]);
  });

  it("the default is search once there are more than ten tools", async () => {
    const { declared, agent } = await drive([{ text: "ok" }], { servers: { many: { command: process.execPath, args: [server, "many"] } } });
    expect(agent.mcp.many).toEqual({ ok: true, toolCount: 12 });
    expect(declared).toContain("tool_search");
    expect(declared.some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  it("exactly ten tools are still declared one by one", async () => {
    const { declared } = await drive([{ text: "ok" }], { servers: { ten: { command: process.execPath, args: [server, "ten"] } } });
    expect(declared.filter((name) => name.startsWith("mcp__ten__"))).toHaveLength(10);
    expect(declared).not.toContain("tool_search");
  });

  it("the default is direct for a few tools", async () => {
    const { declared } = await drive([{ text: "ok" }], { servers: { fake: good } });
    expect(declared).toContain("mcp__fake__echo");
  });

  it("reports a server that failed and still works without it", async () => {
    const { agent, declared } = await drive([{ text: "ok" }], { servers: { fake: good, broken: { command: "/no/such/program" } }, timeoutMs: 2000 });
    expect(agent.mcp.fake?.ok).toBe(true);
    expect(agent.mcp.broken?.ok).toBe(false);
    expect(declared.some((name) => name.startsWith("mcp__broken__"))).toBe(false);
  });

  it("without mcp the status is empty", async () => {
    const agent = await createAgent({ model: createFauxClient([{ text: "x" }]), cwd: process.cwd() });
    expect(agent.mcp).toEqual({});
    await agent.close();
  });
});

describe("codemode asks the plugin that offers authorize", () => {
  const verdict = (outcome: string) => ({ text: JSON.stringify({ risk_level: "low", user_authorization: "high", outcome, rationale: "scripted" }) });
  const script = [
    { toolCalls: [{ name: "run_code", args: { code: "try { return await tools.mcp__fake__echo({text: 'hi'}) } catch (e) { return 'refused: ' + e.message }" }, id: "r" }] },
    { text: "ok" },
  ];

  async function run(extra: Plugin[]) {
    const { corePlugins } = await import("../src/index.ts");
    const agent = await createAgent({ model: createFauxClient(script), cwd: process.cwd(), plugins: [...corePlugins(), ...extra], mcp: { servers: { fake: good }, expose: "codemode" } });
    await agent.run("go").result;
    const results = (await agent.log.project()).filter((message) => message.role === "tool").map(textOf);
    await agent.close();
    return results;
  }

  it("any plugin with an authorize function is asked, and a refusal stops the nested call", async () => {
    const asked: string[] = [];
    const gate = { name: "gate", setup: () => undefined, authorize: async (call: { name: string }) => (asked.push(call.name), { kind: "deny" as const, reason: "gate says no" }) };
    expect(await run([gate])).toEqual(["refused: gate says no"]);
    expect(asked).toEqual(["mcp__fake__echo"]);
  });

  it("without such a plugin the script runs as before", async () => {
    expect(await run([])).toEqual(["echo: hi"]);
  });

  it("with the review plugin: the script call goes to the reviewer, the nested read-only call is allowed by the hard rules", async () => {
    const { reviewPlugin } = await import("@sakura/plugin-review");
    const reviewer = createFauxClient([verdict("allow")]);
    expect(await run([reviewPlugin({ llm: reviewer })])).toEqual(["echo: hi"]);
    expect(reviewer.requests).toHaveLength(1);
  });
});
