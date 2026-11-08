# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

**Sakura 是一个用来搭建编程 Agent 的小型 TypeScript 框架。** 一个约 1200 行、不保存状态的内核负责 Agent 循环，并提供 8 个钩子；其余的一切（文件和 shell 工具、项目说明、预算、自动审核、密钥脱敏、子 Agent、MCP、代码模式）都是可以不装的插件。它以 `sakura-agent` 这个 npm 包发布，包含 SDK 和一个小的 `sakura` 命令行工具。

它起初是一个人自己用的 Agent 架构，现在公开出来，方便别人阅读、使用或拆开研究。它不声称是功能最全的 Agent 框架；目标是保持小而可读，让安全功能可以单独开关。

## 一眼看懂

- **是什么：** 供 TypeScript 代码调用的库，外加一个最小的命令行（`sakura run`、`sakura resume`）。
- **运行环境：** Node.js 26 及以上。开发时直接运行 TypeScript 源码；npm 包里是编译好的 JavaScript。
- **模型：** 任何 OpenAI 风格的 Chat Completions 接口（用 DeepSeek、Kimi、OpenCode Go 试过）。只有一种线协议，按模型配置兼容开关。
- **内核：** 无状态循环、8 个钩子、3 个接口（`LlmClient`、`Log`、`Environment`）、对话压缩和目标。
- **持久化：** 只追加的树形 JSONL 会话文件；崩溃的运行可以在同一个文件上继续。
- **默认启用的插件：** `tools`、`context`、`resilience`、`limits`。**按需开启：** `review`、`redaction`、子 Agent、MCP 客户端、工具搜索、代码模式。
- **安全类插件出错即拒绝：** 审核或脱敏没能完成工作时，动作或请求不会放行。
- **许可：** MIT。

## 适合谁

- 你想要一个坐下来一次就能读完、改起来不需要插件市场的 Agent 循环。
- 你想要把审核和密钥脱敏做成独立、可测试的部件，而不是一个大程序里的开关。
- 你想在自己的应用里运行 Agent，并用代码控制它的模型、会话和工具。

它不是带界面的成品，也不带沙箱：默认的本机环境使用调用进程的权限，不可信的任务请放在你自己的隔离环境里运行。

## 怎么搭的

```
kernel          循环、8 个钩子、3 个接口（LlmClient、Log、Environment）、压缩、目标
session         会话日志：内存版，或 JSONL 文件（树形、单写者、会修复被截断的最后一行）
llm             一种协议（Chat Completions）：重试、断流重发、卡住检测
env             工具在哪里运行：本机，或你提供的远程执行器
agent           createAgent()：把以上装配起来，带一套默认插件
plugins/*       tools、context、resilience、limits、review、redaction、agents、toolset
```

- **内核不保存状态。** 它读日志、问模型、跑工具、写日志。崩溃后在同一份日志上重新运行就能恢复；标成 `replay: "never"` 的工具不会被重复执行，而是得到一条"被中断"的结果。
- **插件只有 8 个钩子可用：** `context`、`request`、`tool.before`、`tool.run`、`tool.after`、`turn.end`、`error`、`event`。插件的形状是 `{ name, compensates?, setup(api), prepare?, afterCompaction? }`；`compensates` 写明它在弥补当今模型的哪个弱点，这样弱点消失后可以删掉它。
- **包的依赖只有一个方向**（内核 ← 基础设施 ← 插件 ← agent），插件之间不互相引用。有脚本检查（`npm run check:boundaries`），同时还限制每个包的导出名字数量、禁止循环引用。

| 插件 | 做什么 | 默认启用 |
|---|---|---|
| `tools` | `read`、`write`、`edit`、`bash`（后台命令、`sleep N` 等待、长输出存成文件） | 是 |
| `context` | 读取 `AGENTS.md` 作为置顶说明，压缩后重读 | 是 |
| `resilience` | 模型回复在写出任何内容之前就被截断（思考型模型把输出上限全用来思考）、回复为空、或（可选）文字写到一半被截断时，让模型再答一次；每一项都可以单独关掉 | 是 |
| `limits` | 轮数、token、费用、运行时间预算；额度不足时暂停 | 是（默认不限） |
| `review` | 对有风险的工具调用做自动审核：硬规则、额外授权方、审核模型；出错一律拒绝 | 否 |
| `redaction` | 请求发出前把密钥换成稳定的占位符，回复里再还原 | 否 |
| `agents` | `delegate`、`agent_view`、`agent_stop` 三个子 Agent 工具（子 Agent 继承审核和脱敏）；用 `subAgents` 选项开启 | 否 |
| `toolset` | BM25 工具搜索、MCP 客户端（stdio）、代码模式（在 QuickJS 沙箱里调用工具的脚本）；用 `mcp` 选项开启 | 否 |

## 安装和运行

```sh
npm install sakura-agent
```

```ts
import { compatPresets, createAgent } from "sakura-agent";

const agent = await createAgent({
  cwd: process.cwd(),
  model: { baseUrl: "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY!, model: "deepseek-flash", contextWindow: 128_000, compat: compatPresets.deepseek },
  tools: ["read"],
  sessionFile: ".sakura/session.jsonl", // 不写则会话只放在内存里
});
try {
  const run = agent.run("总结一下 README.md。");
  for await (const event of run.events) {
    if (event.type === "tool_start") console.log("tool:", event.call.name);
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") console.log(part.text);
    }
  }
  console.log((await run.result).reason); // "done" | "cancelled" | "paused" | "error"
} finally {
  await agent.close(); // 一定要调用：它会停掉还在后台运行的命令，并释放会话文件锁
}
```

要继续一个会话，用同一个 `sessionFile` 创建 Agent，再不带提示词调用 `agent.run()`。

打开安全类插件和子 Agent：

```ts
import { corePlugins, createAgent, redactionPlugin, reviewPlugin } from "sakura-agent";

const redaction = redactionPlugin({ key: "stable-key" });
// `model` 和 `reviewerModel` 是模型配置或客户端，写法同上一个例子
const agent = await createAgent({
  model,
  plugins: [...corePlugins(), redaction, reviewPlugin({ llm: redaction.wrap(reviewerModel) })], // 审核模型也不能看到密钥
  subAgents: {},                                                                                // 子 Agent 拿到同样的插件
  mcp: { servers: { files: { command: "npx", args: ["some-mcp-server"] } }, expose: "codemode" },  // 脚本里的调用同样会被审核
});
```

插件可以包含插件：`bundle("safety", [redaction, review])` 是由两个插件组成的一个插件。`createAgent` 会把每个插件只装一次，按 `requires` 排好顺序，缺依赖、成环或重名时在创建阶段就报错。

## 命令行

```sh
sakura run "读 README.md 并总结" --tools read --session .sakura/demo.jsonl
sakura resume --tools read --session .sakura/demo.jsonl
sakura --help
```

先设置 `DEEPSEEK_API_KEY` 或 `SAKURA_API_KEY`。不传 `--tools` 时命令行不带任何内置工具。加 `--json` 输出 JSON 行，用 `--cwd`、`--base-url`、`--model`、`--context-window` 配置运行。

## 常见问题

**崩溃后怎么恢复？** 会话文件只追加，一条消息完整结束才写一行。在同一个文件上重新运行即可：只读调用如果当时没完成，就直接再跑一次；可能跑了一半的命令得到一条"被中断，请先检查现状"的结果而不是再跑一遍；被截断的最后一行在打开文件时会修复。

**模型能让命令在后台运行吗？** 能。`bash` 有 `background: true` 参数，任何命令跑过 120 秒也会自动转后台。模型会被告知进程号和输出文件，命令结束时也会被告知。一定要调用 `agent.close()`：留着没结束的命令会让 Node 进程一直不退出，`close()`、Ctrl-C 和 `process.exit` 都会停掉它。

**怎么不让模型看到密钥？** `redaction` 插件在每个请求里把密钥（基于 gitleaks 的规则表加几条通用规则）换成稳定的占位符，在工具运行前把回复里的占位符还原，扫描失败时拒绝发出请求。`redaction.wrap(llm)` 让审核模型得到同样的保护。它不能阻止你放行的命令去读它自己进程的环境变量。

**自动审核检查什么？** 先是硬规则（只读命令放行，删除根目录这类灾难性命令拒绝），再是可选的额外授权方，最后是审核模型，按风险和用户授权打分。拒绝会作为工具错误回给 Agent，让它换条路；审核本身出任何故障都按拒绝处理。审核是一道安全网，不是沙箱：它不限制文件访问范围。

**思考型模型把输出上限全用来思考怎么办？** 回复会以 `finish_reason: length` 被截断，而且没有文字。默认启用的 `resilience` 插件会发现这种情况，让模型继续，并把下一次请求的 `max_tokens` 加大（翻倍，封顶 32768）；重试两次之后让运行结束。空回复会再问一次。`resiliencePlugin({ cutEmpty: false })` 可以关掉其中一项。

**支持 MCP 吗？** 作为客户端，走 stdio。工具可以直接声明、通过 BM25 搜索找到，或在代码模式的脚本里调用。脚本里的调用同样经过审核。

**工具在哪里运行？** 在 `Environment` 里。`createLocalEnvironment()` 使用调用进程的权限；`createRemoteEnvironment({ cwd, run })` 把命令交给你提供的执行器（比如一个容器）。它只是适配器，不是沙箱。长命令输出和远程脚本保存在工作目录下的 `.sakura/` 里。

**哪些模型能用？** 任何支持 Chat Completions（含流式和工具调用）的模型。兼容开关覆盖各家的差异（字段名、推理内容、图片处理）。

## 开发

```sh
npm ci
npm run check          # 边界、类型、lint、格式，然后跑全部测试
npm run test:unit      # 一次一个包（packages/*/test）
npm run test:contract  # 同一套测试跑遍一个接口的所有实现
npm run test:tools     # 仓库规则：依赖方向、导出数量上限、无循环引用
npm run example        # 用脚本化模型跑的快速开始示例
npm run build          # 把 SDK 和命令行编译到 dist/
```

所有测试都不调用真实模型。

## 许可

MIT，见 [LICENSE](LICENSE)。取自其他项目的代码和文字（Pi、OpenAI Codex、gitleaks）登记在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，许可证原文在 `licenses/`。早先的 Python 源码保留在仓库历史里。
