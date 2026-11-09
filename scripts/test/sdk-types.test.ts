import { describe, expect, it } from "vitest";
import { createAgent, FatalHookError, ProviderError } from "../../sdk/index.ts";
import type { Decision, Environment, HookContext, Hooks, LlmClient, LlmEvent, LlmRequest, Log, LogEntry, Message, Plugin, PluginApi, ToolCall, Usage } from "../../sdk/index.ts";

// Everything a person needs to write a client, an environment or a plugin must be nameable from the published package alone. This file is
// type-checked by `tsc`; if one of these names is not exported, the check fails. The run at the end shows the pieces fit together.

const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

const client: LlmClient = {
  model: { id: "scripted", contextWindow: 10_000, supportsImages: false },
  async *stream(_request: LlmRequest): AsyncIterable<LlmEvent> {
    yield { type: "text_delta", delta: "hello" };
    yield { type: "usage", usage };
  },
};

const environment = (root: string): Environment => ({
  cwd: root,
  resolve: (path) => path,
  readFile: async () => new Uint8Array(),
  writeFile: async () => undefined,
  stat: async () => undefined,
  list: async () => [],
  exec: async () => ({ exitCode: 0, output: "", timedOut: false }),
  spawn: () => {
    throw new Error("not used");
  },
  dispose: async () => undefined,
});

describe("the SDK names what an extension needs", () => {
  it("a plugin with typed hooks, a client and an environment can be written from the package alone", async () => {
    const seen: string[] = [];
    const refuse: Hooks["tool.before"] = (call: ToolCall, _context: HookContext): Decision | void => {
      seen.push(call.name);
    };
    const plugin: Plugin = {
      name: "typed",
      setup(api: PluginApi) {
        api.on("tool.before", refuse);
        api.on("context", (input: { messages: Message[] }) => void input.messages.length);
      },
    };
    const agent = await createAgent({ model: client, plugins: [plugin], environment: environment("/tmp") });
    const run = agent.run("hi");
    for await (const _event of run.events) void _event;
    expect((await run.result).reason).toBe("done");
    const log: Log = agent.log;
    const entries: readonly LogEntry[] = await log.branch();
    expect(entries.length).toBeGreaterThan(0);
    await agent.close();
  });

  it("an error from a client can be built and told apart", () => {
    const error = new ProviderError("rate_limit", "slow down", 429, 1000);
    expect(error.kind).toBe("rate_limit");
    expect(new FatalHookError("stop")).toBeInstanceOf(Error);
  });
});
