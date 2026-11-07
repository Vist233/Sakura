# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

Sakura 是一个 TypeScript 编程 Agent 框架，提供可恢复的会话和可插拔的工具。应用可以配置 Agent 循环、会话日志和执行环境。

## 快速开始

使用 Node.js 26 和 npm。克隆仓库后，在仓库根目录安装依赖并运行示例。

```sh
git clone https://github.com/Vist233/Sakura.git
cd Sakura
npm ci
npm run example
```

环境中没有 `DEEPSEEK_API_KEY` 时，示例会使用脚本模型。设置该变量后，可以用 DeepSeek 运行同一示例。示例禁用工具，并把会话保存在内存中。

可从 [examples/quickstart.ts](examples/quickstart.ts) 开始编写应用，从工作区的 `@sakura/agent` 导入 `createAgent`。TypeScript 包通过仓库源码提供。

## 主要组件

- 内核运行模型与工具循环，负责上下文压缩，并给插件提供钩子。
- 会话支持内存日志与 JSONL 文件。设置 `sessionFile` 后，可以保存并恢复会话。
- 模型适配层使用 OpenAI 兼容的 Chat Completions，支持流式响应和工具调用。
- 执行环境连接本地或远程文件和命令。可选插件提供审核、脱敏、子 Agent 和 stdio MCP 工具。

默认本地环境沿用调用进程的权限。只给 Agent 开放任务所需的工具，不受信任的任务应使用隔离的执行环境。会话文件和工具输出可能包含敏感内容。审核与脱敏按需启用。如果审核模型也需要脱敏，请单独包装其客户端。

## 开发

```sh
npm run check
```

此命令检查包边界、类型、代码风格和离线测试。离线测试使用脚本模型，无需提供 API 密钥。

TypeScript 项目沿用原仓库。旧 Python 源码可在[最后一个 Python 提交](https://github.com/Vist233/Sakura/tree/3e9b52cca7ff9e69fc6fc5d4b865b5e44ac338dd)中查看。

## 许可

[MIT](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
