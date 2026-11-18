<h1 align="center"><img src="site/assets/readme-banner.png" alt="Sakura：一个完整的 Coding Agent，你可以在它之上构建" width="100%"></h1>

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/sakura-agent)](https://www.npmjs.com/package/sakura-agent)
[![CI](https://github.com/Vist233/Sakura/actions/workflows/ci.yml/badge.svg)](https://github.com/Vist233/Sakura/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-3c873a)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**一个完整的 Coding Agent，你可以在它之上构建。**

Sakura 是一个可组合、可嵌入的 TypeScript Coding Agent Harness。先拿到一个完整的 Agent，再定义你的应用需要的工具、会话、执行环境和执行策略。

[官网](https://sakura.zhangyvjing.com/zh/) · [示例](examples/) · [Sakura Code（终端 Agent）](code/README.zh-CN.md)

## 为什么是 Sakura

Coding Agent 不再只是人打开来用的工具，它也在成为其他软件的一部分：实验平台同时运行多个 Agent，工作中的 Agent 派生一个独立的 Reviewer，应用在本机或另一台机器上执行工具。

从模型 API 开始构建，意味着重写通用的执行机制：Agent Loop、工具执行、会话历史、上下文管理、错误处理和恢复。直接采用完整的终端 Agent 是另一种取舍：你的应用要适应那个产品的交互、工具和生命周期。

Sakura 给你一个完整的 Coding Agent，同时让它的执行边界保持可组合。保留通用的部分，只替换或扩展让你的应用与众不同的部分。

## 快速开始

```sh
npm install sakura-agent
```

```ts
import { compatPresets, createAgent } from "sakura-agent";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY before running this example.");

const agent = await createAgent({
  cwd: process.cwd(),
  model: {
    baseUrl: "https://api.deepseek.com",
    apiKey,
    model: "deepseek-flash",
    contextWindow: 128_000,
    compat: compatPresets.deepseek,
  },
});

try {
  const run = agent.run("Read README.md and summarize the project.");
  for await (const event of run.events) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") process.stdout.write(part.text);
    }
  }
  const result = await run.result;
  console.log(`\nRun: ${result.reason}`); // "done" | "cancelled" | "paused" | "error"
} finally {
  await agent.close();
}
```

- `model` 可以是上面这样的模型配置，也可以是你自己实现的 `LlmClient`。任何支持流式输出和工具调用的 OpenAI 风格 Chat Completions 接口都可以用；不同供应商之间的差异由 `compatPresets` 处理。
- 默认 Agent 带 `read`、`write`、`edit`、`bash` 四个工具，会加载 `AGENTS.md`，上下文快满时自动压缩，回复被截断或为空时自动恢复。
- 传入 `sessionFile`，会话就保存在磁盘上；要续接，用同一个文件创建 Agent，然后不带 prompt 调用 `agent.run()`。
- 一定要调用 `agent.close()`。它会停止还在后台运行的命令，释放会话文件，并关闭执行环境。
- 需要 Node.js 22.18 或更新版本。没有 API Key 时，可以在本仓库运行 `npm run example`，它用一个脚本化的假模型跑同样的流程。

## 只定义差异

一个专用 Agent，就是默认 Agent 加上让它与众不同的那几行。循环、会话、压缩和恢复都不变。

**只读 Reviewer。** 改动：工具和一条规则。

```ts
const reviewer = await createAgent({
  model,
  cwd: "./project",
  tools: ["read"],
  rules: ["Review the code. Do not modify files."],
});
```

**在另一台机器上工作的 Agent。** 改动：工具在哪里执行。

```ts
import { createAgent, createSshEnvironment } from "sakura-agent";

const environment = await createSshEnvironment({ host: "agent@server", cwd: "/srv/project" });
const remote = await createAgent({ model, environment });
```

**测试通过才算完成的 Agent。** 改动：什么时候才算完成。

```ts
const fixer = await createAgent({
  model,
  goal: { objective: "Make all tests pass", verify: "npm test" },
});
```

## 可以组合的部分

| 部分 | 控制什么 |
|---|---|
| `LlmClient` | 模型请求、流式输出、重试和供应商差异 |
| `Log` | 会话历史、分支、fork 和恢复 |
| `Environment` | 文件、Shell、进程，以及它们在哪里运行：本地、SSH 或 Docker |
| 插件和 Hook | 上下文、工具执行、审查、限额、脱敏、子 Agent、事件 |
| 装配 | `createAgent`、`corePlugins` 和 `compose` 把各部分组装成一个 Agent |

没有"模式"。行为来自你组装的模块和数据。

## 子 Agent 复用你的插件

插件之间从不互相导入。装配层在运行时组合它们，子 Agent 继承父 Agent 已安装的插件：

```ts
import { corePlugins, createAgent, reviewPlugin } from "sakura-agent";

const agent = await createAgent({
  model,
  plugins: [...corePlugins(), reviewPlugin({ llm: reviewerModel })],
  subAgents: {},
});
```

- 安装了 `reviewPlugin` 后，每个子 Agent 的工具调用也会被审查，`redaction` 同样会被继承。不需要重新实现，`agents` 插件也不需要导入 `review` 插件。
- 默认情况下，子 Agent 不继承 `agents`、`limits`、`context` 和 `tools`；可以用 `subAgents.notInherited` 自己指定这个列表。
- 子 Agent 拿到的是父 Agent 的插件对象本身，不是副本；所以有状态的插件，其状态由父 Agent 和子 Agent 共享。

## 架构

```text
Products   Sakura Code · Infinity · evaluations
Assembly   createAgent · corePlugins · compose
Plugins    context · tools · resilience · limits · review · redaction · agents · toolset · trace
Core       kernel · llm · env · session · testing
Data       model records · compatibility · image formats · context window
```

Kernel 运行 Agent Loop：读取日志、请求模型、执行工具、把发生的事情追加到日志里，所以崩溃的运行可以从同一份日志继续。`llm`、`env` 和 `session` 分别负责模型通信、执行和会话记录。插件通过八个 Hook 增加可选的策略。装配层把这些模块组合起来，产品在它们之上构建。依赖规则在每次构建时检查（`npm run check:boundaries`）：kernel 不导入任何其他模块，插件之间互不导入。

## 执行边界

- 本地、SSH 和 Docker 是不同的执行环境，不是沙箱。Sakura 不带操作系统级沙箱；本地环境拥有调用进程的全部权限。
- `confine` 约束的是文件工具，不是 Shell。给 Agent Shell 时请同时开启审查，或者把不可信的任务放进你自己提供的隔离环境。
- 审查（`reviewPlugin`）和脱敏都需要主动开启。两者都在失败时拒绝：做不到自己的检查，调用或请求就不会继续。审查读的是调用的文本，它是判断，不是墙。
- Sakura 不替你调度 Agent、容器、CPU 或 GPU。运行多少个 Agent、模型预算、同时跑多少个重型任务，由你的应用决定。
- 续接会话不会撤销已经发生的副作用，也不是 exactly-once：可能执行了一半的命令会被报告为"已中断"，而不是再执行一次。

## 实测

这些数字来自 Sakura Code（基于 Sakura 构建的终端 Agent）的真实使用，不是框架的 Benchmark。每一项都带着条件；完整的分母和统计窗口见[官网](https://sakura.zhangyvjing.com/zh/)。

- **真实使用。** 一台机器上 168 个 Sakura Code 会话，2026-11-09 至 11-18，共 7,150 次工具调用。
- **长时间运行。** 无人值守 20.8 小时：1,822 次模型请求，1,796 次工具调用；整条会话共运行 43.7 小时。
- **审查。** 自审查记录开始（2026-11-10 18:34）以来共 5,314 次审查决定；75 次拒绝中，逐条复核后有 42 次是真实风险，其余是运行取消、硬规则误拦和人工或缓存决定。
- **Terminal-Bench 2.1。** Sakura Code 在一次本地运行中得到 75/88（Pass@1 85.23%）。这是 Sakura Code 的成绩，不是框架的成绩，也不是官方榜单成绩。

## Sakura Code

[`sakuracode`](code/README.zh-CN.md) 是基于这个 SDK 构建的终端 Coding Agent：`npm install -g sakuracode`。它的命令、快捷键、权限预设、配置和 ACP 支持见 [code/README.zh-CN.md](code/README.zh-CN.md)。

## 参考

<details>
<summary>插件</summary>

| 插件 | 作用 | 在 `corePlugins()` 中 |
|---|---|---|
| `tools` | `read`、`write`、`edit`、`bash`（后台命令、`sleep N` 等待、长输出保存到文件） | 是 |
| `context` | 把 `AGENTS.md` 作为固定指令加载，压缩后重新加载 | 是 |
| `resilience` | 回复在写出文字前被截断、回复为空，或（可选）文字中途被截断时，再问一次 | 是 |
| `limits` | 轮次、token、费用和运行时间预算；遇到配额错误时暂停 | 是（不限） |
| `review` | 审查有风险的工具调用：硬规则、额外的授权者、审查模型，或者由人决定（`manual`） | 否 |
| `redaction` | 请求发出前把密钥换成稳定的占位符，回复中再换回来 | 否 |
| `agents` | 子 Agent 的 `delegate`、`agent_view`、`agent_stop`；用 `subAgents` 开启 | 否 |
| `toolset` | BM25 工具搜索、MCP 客户端（stdio）和 code mode；用 `mcp` 开启 | 否 |

`bundle("safety", [redaction, review])` 把两个插件合成一个。`createAgent` 每个插件只安装一次，按 `requires` 排序；缺少依赖、存在循环或名字重复时，在创建时就报错。

</details>

<details>
<summary><code>sakura</code> 命令行</summary>

```sh
sakura run "Read README.md and summarize it" --tools read --session .sakura/demo.jsonl
sakura resume --tools read --session .sakura/demo.jsonl
sakura --help
```

先设置 `DEEPSEEK_API_KEY` 或 `SAKURA_API_KEY`。不传 `--tools` 时，命令行不带任何工具。加 `--json` 输出 JSON lines，或用 `--cwd`、`--base-url`、`--model` 和 `--context-window` 配置这次运行。

</details>

<details>
<summary>常见问题</summary>

**崩溃之后怎么恢复？** 会话文件只追加，一条消息完整之后才写入。在同一个文件上再运行一次 Agent：没结束的只读调用会重新执行，可能执行了一半的命令会得到"已中断，请检查当前状态"的结果，文件末尾被截断的一行在打开时修复。

**可以压缩或回退会话吗？** 接近模型窗口上限时会自动压缩；`agent.run(undefined, { compact: true })` 立即压缩。`agent.rewindTo(entryId)` 在同一个文件里开一个新分支；`agent.fork(path, entryId)` 把到那一点为止的会话复制到一个新文件。

**模型能在后台运行命令吗？** 能。`bash` 支持 `background: true`，运行超过 120 秒的命令会自动转到后台。命令结束时模型会收到通知，也可以要求在那时被唤醒。

**怎样不让模型看到密钥？** `redactionPlugin` 在每个请求里把密钥换成稳定的占位符，工具运行前再换回来；`redaction.wrap(llm)` 让审查模型也受同样的保护。它保护的是发给模型供应商的内容，不是本机存储的内容：分享会话文件或 trace 之前，请先用 `redaction.scrub(text)` 处理。

**支持 MCP 吗？** 作为 stdio 客户端支持。工具可以直接声明、通过 BM25 搜索找到，或者在 code mode 脚本里调用；安装了 `review` 时，脚本里的每次调用仍然逐个审查。

**哪些模型可以用？** 任何支持流式输出和工具调用的 Chat Completions 接口（试过 DeepSeek、Kimi 和 OpenCode Go）。

</details>

## 开发

```sh
npm ci
npm run check          # 边界、类型、lint、格式，然后跑全部测试
npm run test:unit      # 逐个包运行
npm run test:contract  # 同一套测试跑一个接口的所有实现
npm run example        # 用脚本化的假模型运行快速开始示例
npm run build          # 把 SDK 和命令行编译到 dist/
```

所有测试都不调用真实模型。

## 许可证

MIT，见 [LICENSE](LICENSE)。取自其他项目（Pi、OpenAI Codex、gitleaks）的代码和文字列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，它们的许可证在 [`licenses/`](licenses/)。
