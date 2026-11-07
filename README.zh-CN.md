# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

**Sakura 是一个可嵌入应用的 TypeScript SDK，用于构建支持会话恢复和可配置工具执行的编程 Agent。**

Sakura 源于一个实际需求：让 Agent 在自己的应用里运行，从代码控制模型、会话和工具。`sakura` CLI 使用同一套 SDK，可在终端或脚本里调用。

## 运行示例

使用 Node.js 26 和 npm。

已发布的版本可用 `npm install sakura-agent` 安装。下面的命令从源码运行示例。

```sh
git clone https://github.com/Vist233/Sakura.git
cd Sakura
npm ci
npm run example
npm run example:tools
```

示例默认使用脚本模型。设置 `DEEPSEEK_API_KEY` 后可用 DeepSeek 运行。[工具示例](examples/tools.ts) 会注册一个函数，并显示 Agent 对它的调用。

## 创建 Agent 并添加工具

安装包后从 `sakura-agent` 导入。本仓库中的相同接口位于 `sdk/index.ts`。下面的示例使用环境变量 `DEEPSEEK_API_KEY`。

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

| 配置 | 作用 |
| --- | --- |
| `model` | 设置服务地址、密钥、模型名和上下文窗口，也可传入 `LlmClient`。 |
| `tools` | 从 `read`、`write`、`edit`、`bash` 中选择内置工具。传入 `[]` 可关闭。 |
| `plugins` | 注册自定义工具或添加行为。这份列表会替换默认配置，需要的默认插件可从 `corePlugins()` 加回。在 `execute()` 中校验工具参数。 |
| `mcp` | 启动 stdio MCP 服务，并向 Agent 暴露工具。 |
| `cwd`、`environment` | 选择工具的工作目录，或提供自定义执行环境。 |
| `sessionFile` | 把会话保存为 JSONL。恢复时用同一个文件创建 Agent，再调用无参数的 `agent.run()`。 |
| `maxTokens`、`limitsPlugin()` | 设置单次请求的输出上限，以及会话或运行预算。 |

接入已有 stdio MCP 服务时，把下面的属性加入同一份配置。换成实际的启动命令和参数，再通过 `agent.mcp` 检查启动状态。

```ts
mcp: {
  servers: {
    project: { command: "node", args: ["./your-mcp-server.mjs"] },
  },
  expose: "direct",
}
```

## 使用 CLI

从源码运行时，先执行 `npm run build`，再用 `node dist/sdk/cli.js` 代替 `sakura`。安装包提供 `sakura` 命令。先设置 `DEEPSEEK_API_KEY` 或 `SAKURA_API_KEY`。

```sh
sakura run "Read README.md and summarize it" --tools read --session .sakura/demo.jsonl
sakura resume --tools read --session .sakura/demo.jsonl
sakura --help
```

加 `--json` 可按行输出 JSON。用 `--cwd`、`--base-url`、`--model`、`--context-window` 配置运行。CLI 默认不开放内置工具，使用时按需选择。

## 选择工具执行位置

SDK 管理 Agent 循环、模型请求和会话状态。执行环境负责文件与 shell。用 `createLocalEnvironment()` 在本地执行，或给 `createRemoteEnvironment({ cwd, run })` 传入自己的执行器。例如，本地应用可以管理会话，把构建交给装好依赖的 Linux 工作环境。

默认本地环境沿用进程权限。`cwd` 用于选择工作目录。不受信任的任务应使用隔离执行器。会话文件和 JSON 事件日志可能包含敏感内容。审核与脱敏按需启用，独立的审核客户端需要单独包装脱敏。

## 验证

公开 CI 在 Linux 和 macOS 跑离线检查。在一轮独立的本地 DeepSeek Flash 评测中，Sakura 通过了 10 项 Lean 证明检查和 20 项追加日志检查，两项任务合计通过 96 次后台校验。评测使用外部隔离，传输故障后从检查点续跑。

```sh
npm run check
```

## 许可

[MIT](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md) · [旧 Python 源码](https://github.com/Vist233/Sakura/tree/3e9b52cca7ff9e69fc6fc5d4b865b5e44ac338dd)
