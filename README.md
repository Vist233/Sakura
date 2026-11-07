# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

**Sakura is an embeddable TypeScript SDK for building coding agents with resumable sessions and configurable tool execution.**

Sakura grew out of a need to run an agent as part of an application and control its models, sessions, and tools from code. The `sakura` CLI uses the same SDK for terminal and script workflows.

## Run the examples

Use Node.js 26 and npm.

Install a published version with `npm install sakura-agent`. The commands below run the examples from source.

```sh
git clone https://github.com/Vist233/Sakura.git
cd Sakura
npm ci
npm run example
npm run example:tools
```

The examples use a scripted model by default. Set `DEEPSEEK_API_KEY` to run them with DeepSeek. The [tool example](examples/tools.ts) registers a function and shows the agent calling it.

## Create an agent and add tools

Import from `sakura-agent` in an installed package. In this repository, the same API is available from `sdk/index.ts`. The following example expects `DEEPSEEK_API_KEY` in the environment.

```ts
import { compatPresets, corePlugins, createAgent, limitsPlugin } from "sakura-agent";
import type { Plugin } from "sakura-agent";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY.");

const projectTools: Plugin = {
  name: "project-tools",
  setup(api) {
    api.registerTool({
      name: "project_status",
      description: "Return the status of the sample project.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      async execute() {
        return { content: [{ type: "text", text: "Build passed." }] };
      },
    });
  },
};

const agent = await createAgent({
  model: {
    baseUrl: "https://api.deepseek.com",
    apiKey,
    model: "deepseek-flash",
    contextWindow: 128_000,
    compat: compatPresets.deepseek,
  },
  cwd: process.cwd(),
  tools: ["read"],
  plugins: [
    ...corePlugins().filter((plugin) => plugin.name !== "limits"),
    limitsPlugin({ maxTurns: 8 }),
    projectTools,
  ],
  sessionFile: ".sakura/session.jsonl",
  maxTokens: 1_024,
});

try {
  const run = agent.run("Call project_status and tell me the result.");
  for await (const event of run.events) {
    if (event.type === "tool_start") console.log(event.call.name);
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") console.log(part.text);
    }
  }
  console.log(await run.result);
} finally {
  await agent.close();
}
```

| Configuration | What it controls |
| --- | --- |
| `model` | Provider URL, API key, model name, and context window. You can also pass an `LlmClient`. |
| `tools` | Selects built-in tools from `read`, `write`, `edit`, and `bash`. Pass `[]` to disable them. |
| `plugins` | Registers custom tools or adds behavior. This list replaces the defaults, so include the desired `corePlugins()`. Validate tool arguments in `execute()`. |
| `mcp` | Starts stdio MCP servers and exposes their tools to the agent. |
| `cwd`, `environment` | Choose the tool working directory or supply a custom execution environment. |
| `sessionFile` | Saves the session as JSONL. To resume, create an agent with the same file and call `agent.run()` without a prompt. |
| `maxTokens`, `limitsPlugin()` | Set a per-request output limit and session or run budgets. |

For an existing stdio MCP server, add this property to the same configuration. Use your own server command and arguments. Check `agent.mcp` for startup status.

```ts
mcp: {
  servers: {
    project: { command: "node", args: ["./your-mcp-server.mjs"] },
  },
  expose: "direct",
}
```

## Use the CLI

From source, run `npm run build` and use `node dist/sdk/cli.js` in place of `sakura`. An installed package provides the `sakura` executable. Set `DEEPSEEK_API_KEY` or `SAKURA_API_KEY` first.

```sh
sakura run "Read README.md and summarize it" --tools read --session .sakura/demo.jsonl
sakura resume --tools read --session .sakura/demo.jsonl
sakura --help
```

Add `--json` for JSON lines or use `--cwd`, `--base-url`, `--model`, and `--context-window` to configure the run. The CLI starts with no built-in tools unless you select them.

## Choose where tools run

The SDK manages the agent loop, model requests, and session state. The execution environment handles files and shell commands. Use `createLocalEnvironment()` for local execution or `createRemoteEnvironment({ cwd, run })` with a runner you provide. For example, a local application can manage sessions while a Linux worker runs builds with its own dependencies.

The default local environment uses the calling process's permissions. `cwd` selects a working directory. Use an isolated runner for untrusted workloads. Session files and JSON event logs can contain sensitive content. Review and redaction are opt-in, and a separate reviewer client needs its own redaction wrapper.

## Validation

The public CI runs offline checks on Linux and macOS. In a separate local evaluation with DeepSeek Flash, Sakura passed 10 Lean proof checks and 20 append-log checks. Across both tasks it passed 96 background checks. The evaluation used an external isolation layer and resumed from checkpoints after transport failures.

```sh
npm run check
```

## License

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Previous Python source](https://github.com/Vist233/Sakura/tree/3e9b52cca7ff9e69fc6fc5d4b865b5e44ac338dd)
