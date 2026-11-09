# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

**Sakura 是一个能嵌入、能审核、能放在任何地方的 Agent 循环。** 一个小小的 TypeScript 内核（约 1600 行、8 个钩子）负责循环，其余的一切都是可以不装的插件。你像定义一个对象那样用代码定义 Agent，工具就是普通对象，并且精确决定它能触到哪里：这个目录、通过 SSH 连上的另一台机器，或者任何能执行命令的函数。它以 `sakura-agent` 这个 npm 包发布，包含 SDK 和一个小的 `sakura` 命令行工具；仓库里还有一个基于同一个 SDK 的、类似 Codex 的终端。

## 为什么用 Sakura

- **一个 Agent 就是几行代码。** `createAgent({ model, tools, rules, plugins })`；工具是普通对象（名字、JSON Schema、一个 `execute` 函数）；Python 或 shell 工具就是让 `bash` 工具或环境执行的一条命令。不用安装什么，也不用生成配置文件。
- **命令行 Agent 该有的，用代码拼出来。** 可恢复的会话（分叉、回退、崩溃恢复）、对话压缩、目标、运行中引导 / 排队 / 取消、项目说明（`AGENTS.md`）、子 Agent、MCP、工具搜索和代码模式。每一项都是插件或选项，不需要的就不要。
- **你决定它能触到哪里。** 每个 Agent 有自己的工作目录和自己的 `Environment`，不读进程的当前目录。`confine: true` 让文件工具出不了这个目录，不管路径怎么写（绝对路径、`..`、链接）。`createSshEnvironment` 用一次 SSH 登录在另一台机器上运行工具，并告诉模型它在那里。任何能执行 shell 命令的函数都可以做环境，所以循环可以跑在放密钥的地方，工具跑在干活的地方。
- **用审核代替人在旁边。** `review` 插件先用硬规则、再用审核模型判断有风险的工具调用，熔断器会让一直被拒绝的运行停下来。Agent 可以无人值守。而且当一个 Agent 没有 shell（比如只有文件工具和一个回答真或假的检查器）时，限定的目录就是它需要的全部安全措施，不用再运行第二个模型。
- **想要终端也有。** `terminal/` 是一个类似 Codex 的终端（Markdown 输出、斜杠命令、续接、分叉、`exec --json`），只用公开的 SDK 写成。它在仓库里，不在 npm 包里。
- **小到能读完，按产品标准测试。** 公开仓库里有 5000 多个测试，有对每个接口的所有实现跑同一套用例的契约测试，还有对真实模型和真实 SSH 服务器的实测。

## 和别的工具比

我对比过的两个工具，依据它们公开的文档（2026 年 11 月）。它们是给坐在键盘前的人用的产品；Sakura 是可以拆开、嵌进去的那一部分。

| | Codex CLI | pi | Sakura |
|---|---|---|---|
| 是什么 | 终端 Agent 产品；`exec --json` 用于自动化；可以作为 MCP 服务运行 | “极简、可扩展的 Agent 工具集”；交互、打印 / JSON、RPC 三种模式，有 TypeScript SDK | 以库为主，带一个最小命令行和一个单独的终端 |
| 怎么保证动作安全 | 沙箱模式（只读、工作区可写、完全访问）加批准策略 | 其 README 没有说明 | 带硬规则和熔断器的审核，不需要人；文件工具有 `confine`；自己不带沙箱 |
| 子 Agent、计划模式 | 没有核对 | 有意不做 | 内置子 Agent（按需开启） |
| 工具在哪里运行 | 本机，在沙箱里 | 其 README 没有说明 | 本机、SSH，或任何函数，每个 Agent 各自选择 |
| 模型 | 默认是 OpenAI 的模型 | 用 `/login` 连接内置的服务商 | 任何 Chat Completions 接口（用 DeepSeek、Kimi、OpenCode Go 试过） |

来源：[Codex CLI 文档](https://developers.openai.com/codex)、[pi README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)。细节请以它们当前的文档为准，两者都变得很快。

## 适合谁

- 你让 Agent **无人看着也能运行**：批处理、很多个 Agent、远程机器，或者放在你自己的产品里。
- 你想用代码定义 Agent，并从那里控制它的模型、会话、工具和能触到的范围。
- 你想要把审核和密钥脱敏做成独立、可测试的部件，而不是一个大程序里的开关，以及一个坐下来一次就能读完的循环。

它不是给你自己笔记本用的全能助手，也不带沙箱：默认的本机环境使用调用进程的权限。`confine` 是文件工具的边界，不是 shell 的边界：shell 命令仍然能触到任何地方，所以给 Agent 一个 shell 时要同时开启审核，或者把不可信的任务放在你自己的隔离环境里运行。

## Agent 能触到哪里

```ts
import { createAgent, createSshEnvironment, corePlugins, reviewPlugin } from "sakura-agent";
import type { Tool } from "sakura-agent";

// 工具就是普通对象
const checkProof: Tool = {
  name: "check_proof",
  description: "检查 proof.txt，回答 true 或 false。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  effect: "read",
  async execute(_args, { env }) {
    const proof = new TextDecoder().decode(await env.readFile("proof.txt"));
    return { content: [{ type: "text", text: String(proof.includes("QED")) }] };
  },
};

// 1. 没有 shell，限定在自己的目录里：不需要审核
const prover = await createAgent({ model, cwd: "/work/job-17", confine: true, tools: ["read", "write", "edit", checkProof] });

// 2. 同一个循环，工具跑在另一台机器上，并对在那里运行的命令开启审核
const environment = await createSshEnvironment({ host: "agent@box", cwd: "/srv/job-17" });
const remote = await createAgent({ model, environment, plugins: [...corePlugins(), reviewPlugin({ llm: reviewerModel })] });
```

## 一眼看懂

- **是什么：** 供 TypeScript 代码调用的库，外加一个最小的命令行（`sakura run`、`sakura resume`），仓库里还有一个终端。
- **运行环境：** Node.js 26 及以上。开发时直接运行 TypeScript 源码；npm 包里是编译好的 JavaScript。
- **模型：** 任何 OpenAI 风格的 Chat Completions 接口（用 DeepSeek、Kimi、OpenCode Go 试过）。只有一种线协议，按模型配置兼容开关。
- **内核：** 无状态循环、8 个钩子、3 个接口（`LlmClient`、`Log`、`Environment`）、对话压缩和目标。
- **持久化：** 只追加的树形 JSONL 会话文件；崩溃的运行可以在同一个文件上继续。
- **默认启用的插件：** `tools`、`context`、`resilience`、`limits`。**按需开启：** `review`、`redaction`、子 Agent、MCP 客户端、工具搜索、代码模式。
- **安全类插件出错即拒绝：** 审核或脱敏没能完成工作时，动作或请求不会放行。
- **许可：** MIT。

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
| `limits` | 轮数、token、费用、运行时间预算（运行时间在每个回合结束时检查，不是回合进行中）；额度不足时暂停 | 是（默认不限） |
| `review` | 对有风险的工具调用做自动审核：硬规则、额外授权方、审核模型；出错一律拒绝 | 否 |
| `redaction` | 请求发出前把密钥换成稳定的占位符，回复里再还原 | 否 |
| `agents` | `delegate`、`agent_view`、`agent_stop` 三个子 Agent 工具（子 Agent 继承审核和脱敏）；用 `subAgents` 选项开启 | 否 |
| `toolset` | BM25 工具搜索、MCP 客户端（stdio）、代码模式（让模型写脚本一次调用多个工具，脚本在隔离的 JavaScript 运行环境里执行）；用 `mcp` 选项开启 | 否 |

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

**能自己手动压缩对话吗？** 能。上下文进入模型窗口剩余 17%（且不少于 16384 个 token）时会自动压缩；`agent.run(undefined, { compact: true })` 则立刻压缩，不管多大：把较早的部分写成摘要，较新的部分原样保留，并用 `compaction` 事件告诉你（没有值得总结的内容时没有这个事件）。`agent.run("下一个问题", { compact: true })` 先压缩再回答，新问题不会被写进摘要。

**能回到对话的某个早先位置吗？** 能，有两种办法。`agent.rewindTo(条目 id)` 在同一个会话文件里回退：接下来说的话开出新分支，旧分支仍在文件里。`agent.fork(路径, 条目 id)` 把到那个点为止的对话复制成一个新的会话文件，用 `createAgent({ sessionFile: 路径 })` 打开；原会话不变，两边都可以继续。分叉不会把一个回合切成两半：最后一条消息里的工具调用的结果会一起带上。

**模型能让命令在后台运行吗？** 能。`bash` 有 `background: true` 参数，任何命令跑过 120 秒也会自动转后台。模型会被告知进程号和输出文件，命令结束时也会被告知。模型可以要求命令结束时叫醒自己（`bash` 调用里写 `wake: true`，不需要就写 `wake: false`）；应用用 `createAgent` 的 `wake` 选项设置默认值。一定要调用 `agent.close()`：留着没结束的命令会让 Node 进程一直不退出，`close()`、Ctrl-C 和 `process.exit` 都会停掉它。

**怎么不让模型看到密钥？** `redaction` 插件在每个请求里把密钥（基于 gitleaks 的规则表加几条通用规则）换成稳定的占位符，在工具运行前把回复里的占位符还原，扫描失败时拒绝发出请求。`redaction.wrap(llm)` 让审核模型得到同样的保护。它保护的是发给模型服务商的内容，不是保存在本机的内容：会话文件、事件和追踪里保留真实值（工具要用它们，恢复会话也是从那个文件读），导出或分享前请先用 `redaction.scrub(text)` 打码。它不能阻止你放行的命令去读它自己进程的环境变量。

**自动审核检查什么？** 先是硬规则（留在工作目录内的只读命令放行，删除根目录这类灾难性命令拒绝；指向工作目录之外的只读命令交给审核模型），再是可选的额外授权方，最后是审核模型，按风险和用户授权打分。拒绝会作为工具错误回给 Agent，让它换条路；审核本身出任何故障都按拒绝处理。审核是一道安全网，不是沙箱：它只读命令的文字，跟不到符号链接，也不限制文件访问范围。

**思考型模型把输出上限全用来思考怎么办？** 回复会以 `finish_reason: length` 被截断，而且没有文字。默认启用的 `resilience` 插件会发现这种情况，让模型继续，并把下一次请求的 `max_tokens` 加大（翻倍，封顶 32768）；重试两次之后让运行结束。空回复会再问一次。`resiliencePlugin({ cutEmpty: false })` 可以关掉其中一项。

**支持 MCP 吗？** 作为客户端，走 stdio。工具可以直接声明、通过 BM25 搜索找到，或在代码模式的脚本里调用。

**什么是代码模式？脚本已经在隔离的运行环境里了，为什么脚本里的调用还要审核？** 代码模式是让模型写一小段 JavaScript，在一段程序里调用多个工具，而不是每次请求只调一个。这段程序在隔离的 JavaScript 运行环境里执行（QuickJS 编译成 WebAssembly），它只管住**程序本身**碰不到机器，不是命令的沙箱。它调用的工具（一条 shell 命令、一次写文件、一个 MCP 工具）是在这个运行环境之外以完整权限运行的，所以脚本里的一次调用和直接发起同一次调用风险一样。脚本里的调用不经过循环的钩子，所以要明确地去请求审核：装了 `review` 插件，脚本里的每一次调用都会逐个被审核（脚本整体不再重复审核），被拒绝就在脚本里变成一个错误；没装，所有调用直接执行，和没有审核时的直接调用一样。

**工具在哪里运行？** 在 `Environment` 里。`createLocalEnvironment()` 使用调用进程的权限；`createRemoteEnvironment({ cwd, run })` 把命令交给你提供的执行器（比如一个容器）。它只是适配器，不是沙箱。`createSshEnvironment({ host, cwd })` 是用于能通过 ssh 到达的机器的适配器：登录一次，所有命令都走这一条连接，并在系统提示里告诉模型它的工具在别处执行、连接可能出问题（出问题时工具结果会如实说明，并给出命令输出所在的位置，绝不会把连接断了说成命令结束了）。认证和主机密钥完全由你的 ssh 配置决定；远端机器需要 `bash`、`base64` 和 `setsid`，所以应当是 Linux 而不是 macOS。在本机，超时、取消和退出会停掉命令以及它启动的所有进程，但停不掉自己开了新会话的进程（比如用 `setsid`）；要停掉所有进程，请把命令放进容器。长命令输出和远程脚本保存在工作目录下的 `.sakura/` 里。

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
