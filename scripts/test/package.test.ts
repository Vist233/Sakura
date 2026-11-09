import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// What the repository tests cannot show: that the package a person installs works when it is only the package. It is built and packed, unpacked into
// an empty directory (with only its one dependency linked in), and used there the way the README says.
const root = join(import.meta.dirname, "..", "..");
let work: string;
let installed: string;

const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "sakura-package-"));
  run("node", ["scripts/build-sdk.mjs"], root);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], root)) as Array<{ filename: string }>;
  installed = join(work, "node_modules", "sakura-agent");
  mkdirSync(installed, { recursive: true });
  run("tar", ["-xzf", join(work, packed[0]!.filename), "-C", installed, "--strip-components=1"], work);
  symlinkSync(join(root, "node_modules", "quickjs-emscripten"), join(work, "node_modules", "quickjs-emscripten"));
}, 120_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the installed package", () => {
  it("is used from its name alone: custom tool, rules, a configured core plugin, context and usage", () => {
    writeFileSync(
      join(work, "use.mjs"),
      `
      import { createAgent, corePlugins, contextPlugin, toolsPlugin, resiliencePlugin, limitsPlugin, ProviderError } from "sakura-agent";
      let calls = 0;
      const requests = [];
      const model = {
        model: { id: "scripted", contextWindow: 50000, supportsImages: false },
        async *stream(request) {
          requests.push(request);
          const usage = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 };
          if (request.messages.at(-1).role === "tool") yield { type: "text_delta", delta: "done" };
          else yield { type: "tool_call", call: { id: "t1", name: "project_status", args: {} } };
          yield { type: "usage", usage };
        },
      };
      const tool = {
        name: "project_status", description: "Return the status of the sample project.", effect: "read",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { calls++; return { content: [{ type: "text", text: "Build passed." }] }; },
      };
      const agent = await createAgent({
        model, cwd: process.cwd(), tools: ["read", tool], rules: ["Answer in French."],
        plugins: [contextPlugin(), toolsPlugin(), resiliencePlugin({ cutEmpty: false }), limitsPlugin()],
      });
      const run = agent.run("how is the build?");
      for await (const _event of run.events) void _event;
      const result = await run.result;
      await agent.setGoal({ objective: "keep the build green" });
      const goal = await agent.goal();
      await agent.clearGoal();
      const ended = await agent.goal();
      console.log(JSON.stringify({
        goal: goal.objective, goalStatus: goal.status, endedStatus: ended.status, pending: agent.pending(),
        reason: result.reason, calls, core: corePlugins().length, kind: new ProviderError("auth", "x").kind,
        tools: requests[0].tools.map((t) => t.name), rule: requests[0].system.includes("- Answer in French."),
        context: await agent.context(), usage: await agent.usage(),
      }));
      await agent.close();
      `,
    );
    const seen = JSON.parse(run("node", ["use.mjs"], work));
    expect(seen).toMatchObject({
      reason: "done",
      calls: 1,
      core: 4,
      kind: "auth",
      tools: ["read", "project_status"],
      rule: true,
      goal: "keep the build green",
      goalStatus: "active",
      endedStatus: "complete",
      pending: { signals: [], watching: [] },
    });
    expect(seen.usage).toMatchObject({ turns: 2, input: 2400, output: 160 });
    expect(seen.context).toMatchObject({ tokens: 1280, window: 50000, free: 48720 });
  });

  it("offers a scripted model on its own entry point, so an application can test itself without a provider", () => {
    writeFileSync(
      join(work, "testing.mjs"),
      `
      import { createAgent } from "sakura-agent";
      import { createFauxClient } from "sakura-agent/testing";
      const agent = await createAgent({ model: createFauxClient([{ text: "scripted reply" }]), cwd: process.cwd() });
      const run = agent.run("hi");
      for await (const _event of run.events) void _event;
      const message = (await agent.log.project()).at(-1);
      console.log(JSON.stringify({ reason: (await run.result).reason, text: message.content[0].text }));
      await agent.close();
      `,
    );
    expect(JSON.parse(run("node", ["testing.mjs"], work))).toEqual({ reason: "done", text: "scripted reply" });
  });

  it("brings types that a TypeScript user can write a client, an environment and a plugin against", () => {
    writeFileSync(
      join(work, "types.ts"),
      `
      import type { Agent, AgentConfig, ContextStatus, Environment, GoalRecord, Hooks, LlmClient, LlmEvent, LlmRequest, Log, Message, Plugin, PluginApi, Tool, Usage, UsageTotals } from "sakura-agent";
      import { ProviderError, resiliencePlugin } from "sakura-agent";
      const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
      export const client: LlmClient = {
        model: { id: "m", contextWindow: 1000, supportsImages: false },
        async *stream(_request: LlmRequest): AsyncIterable<LlmEvent> { yield { type: "usage", usage }; },
      };
      export const hook: Hooks["context"] = (input: { messages: Message[] }) => input.messages;
      export const plugin: Plugin = { name: "p", setup(api: PluginApi) { api.on("context", hook); } };
      export const tool: Tool = { name: "t", description: "d", parameters: {}, effect: "read", async execute() { return { content: [] }; } };
      export const config: AgentConfig = { model: client, tools: ["bash", tool], rules: ["r"], plugins: [resiliencePlugin({ empty: false }), plugin] };
      export const error = new ProviderError("other", "x");
      export async function show(agent: Agent, log: Log, env?: Environment): Promise<[ContextStatus, UsageTotals, GoalRecord | undefined]> { void log; void env; await agent.setGoal({ objective: "o", verify: "true" }); return [await agent.context(), await agent.usage(), await agent.goal()]; }
      `,
    );
    writeFileSync(
      join(work, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "esnext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
          typeRoots: [join(root, "node_modules", "@types")],
        },
        files: ["types.ts"],
      }),
    );
    expect(run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], work)).toBe("");
  });
}, 120_000);
