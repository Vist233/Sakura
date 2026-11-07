# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

Sakura is a TypeScript framework for building coding agents with resumable sessions and pluggable tools. It provides an agent loop, a session log, and an execution environment that you can configure from your application.

## Quick start

Use Node.js 26 and npm. Install and run from the repository root.

```sh
git clone https://github.com/Vist233/Sakura.git
cd Sakura
npm ci
npm run example
```

The example uses a scripted model when `DEEPSEEK_API_KEY` is unset. Set that variable to run the same example with DeepSeek. The example runs without tools and keeps the session in memory.

Use [examples/quickstart.ts](examples/quickstart.ts) as the starting point for your application. Import `createAgent` from the `@sakura/agent` workspace package. The TypeScript packages are available from source.

## How it works

- The kernel runs the model and tool loop, handles context compaction, and exposes hooks for plugins.
- The session package provides an in-memory log and a file-backed JSONL log. Set `sessionFile` to save and resume a session.
- The model adapter uses OpenAI-compatible Chat Completions with streamed responses and tool calls.
- The execution environment connects the agent to local or remote files and commands. Optional plugins provide review, redaction, subagents, and stdio MCP tools.

The default local environment runs with your process permissions. Give agents only the tools they need. Use an isolated execution environment for untrusted tasks. Session files and tool outputs can contain sensitive data. Review and redaction are opt-in. Wrap the reviewer client separately if it needs redaction.

## Development

```sh
npm run check
```

This command checks package boundaries, types, lint, formatting, and offline tests. The test suite uses scripted models and runs without provider credentials.

This TypeScript project continues in the original repository. The previous Python source is available in the [last Python commit](https://github.com/Vist233/Sakura/tree/3e9b52cca7ff9e69fc6fc5d4b865b5e44ac338dd).

## License

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
