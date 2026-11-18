# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/sakura-agent)](https://www.npmjs.com/package/sakura-agent)
[![CI](https://github.com/Vist233/Sakura/actions/workflows/ci.yml/badge.svg)](https://github.com/Vist233/Sakura/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.18-3c873a)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A complete coding agent you can build with.**

Sakura is a composable, embeddable coding agent harness for TypeScript. Start with a complete agent, then define the tools, sessions, environments and execution policies your application needs.

[Website](https://sakura.zhangyvjing.com) · [Examples](examples/) · [Sakura Code, the terminal agent](code/README.md)

## Why Sakura

Coding agents are no longer only tools that people open and use. They are becoming parts of other software: an experiment platform runs several agents at once, a working agent forks a separate reviewer, an application runs tools on the local machine or on another one.

Building that from model APIs means rebuilding the common machinery: the agent loop, tool execution, session history, context management, error handling and recovery. Starting from a complete terminal agent is a different trade-off: your application adapts to that product's interaction, tools and lifecycle.

Sakura gives you a complete coding agent whose execution boundaries stay composable. Keep the common machinery; replace or extend only what makes your application different.

## Quick start

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

- `model` is either model settings like the ones above or your own `LlmClient`. Any OpenAI-style Chat Completions endpoint with streaming and tool calls works; `compatPresets` covers the differences between providers.
- The default agent has the `read`, `write`, `edit` and `bash` tools, loads `AGENTS.md`, compacts the conversation when the context fills and recovers from replies that were cut off or came back empty.
- Give it a `sessionFile` to keep the conversation on disk; to resume, create an agent with the same file and call `agent.run()` without a prompt.
- Always call `agent.close()`. It stops commands still running in the background, releases the session file and closes the environment.
- Node.js 22.18 or newer. Without a key, `npm run example` in this repository runs the same flow against a scripted model.

## Define only the difference

A specialised agent is the default agent plus the lines that make it different. The loop, sessions, compaction and recovery stay the same.

**A read-only reviewer.** Changes: the tools and one rule.

```ts
const reviewer = await createAgent({
  model,
  cwd: "./project",
  tools: ["read"],
  rules: ["Review the code. Do not modify files."],
});
```

**An agent on another machine.** Changes: where the tools run.

```ts
import { createAgent, createSshEnvironment } from "sakura-agent";

const environment = await createSshEnvironment({ host: "agent@server", cwd: "/srv/project" });
const remote = await createAgent({ model, environment });
```

**An agent that is done only when the tests pass.** Changes: when the work counts as done.

```ts
const fixer = await createAgent({
  model,
  goal: { objective: "Make all tests pass", verify: "npm test" },
});
```

## What you can compose

| Part | What it controls |
|---|---|
| `LlmClient` | model requests, streaming, retries and provider differences |
| `Log` | the conversation history, branches, forks and recovery |
| `Environment` | files, shell, processes and where they run: local, SSH or Docker |
| Plugins and hooks | context, tool execution, review, limits, redaction, sub-agents, events |
| Assembly | `createAgent`, `corePlugins` and `compose` put the parts together into one agent |

There are no modes. Behaviour comes from the modules and data you assemble.

## Sub-agents reuse your plugins

Plugins never import each other. The assembly composes them at run time, and a sub-agent inherits the plugins its parent has installed:

```ts
import { corePlugins, createAgent, reviewPlugin } from "sakura-agent";

const agent = await createAgent({
  model,
  plugins: [...corePlugins(), reviewPlugin({ llm: reviewerModel })],
  subAgents: {},
});
```

- With `reviewPlugin` installed, every sub-agent's tool calls are reviewed too, and `redaction` carries over the same way. Nothing is reimplemented, and the `agents` plugin does not import the `review` plugin.
- By default a sub-agent does not inherit `agents`, `limits`, `context` and `tools`; set `subAgents.notInherited` to choose that list yourself.
- A sub-agent receives the parent's plugin objects, not copies, so a plugin that keeps state shares it between parent and sub-agents.

## Architecture

```text
Products   Sakura Code · Infinity · evaluations
Assembly   createAgent · corePlugins · compose
Plugins    context · tools · resilience · limits · review · redaction · agents · toolset · trace
Core       kernel · llm · env · session · testing
Data       model records · compatibility · image formats · context window
```

The kernel runs the agent loop: it reads the log, asks the model, runs tools and appends what happened, so a crashed run continues from the same log. `llm`, `env` and `session` handle model traffic, execution and the conversation record. Plugins add optional policy through eight hooks. The assembly composes these modules, and products build on them. The dependency rules are checked on every build (`npm run check:boundaries`): the kernel imports nothing else, and plugins never import each other.

## Execution boundaries

- Local, SSH and Docker are different environments, not sandboxes. Sakura ships no operating-system sandbox; the local environment has the permissions of the calling process.
- `confine` bounds the file tools, not the shell. Give an agent a shell together with the review, or run untrusted work in an isolation you provide.
- Review is opt-in (`reviewPlugin`), and so is redaction. Both fail closed: if they cannot do their job, the call or request does not go ahead. Review reads the text of a call; it is a judgement, not a wall.
- Sakura does not schedule your agents, containers, CPUs or GPUs. How many agents run, the model budget and how many heavy jobs run at once are decisions of your application.
- Resuming a session does not undo side effects that already happened, and it is not exactly-once: a command that may have half run is reported as interrupted instead of being run again.

## Evidence

These numbers come from real use of Sakura Code, the terminal agent built on Sakura, not from a framework benchmark. Each comes with its conditions; the full denominators and windows are on the [website](https://sakura.zhangyvjing.com).

- **Real usage.** 168 Sakura Code sessions on one machine, 2026-11-09 to 11-18, with 7,150 tool calls.
- **Long run.** 20.8 hours unattended: 1,822 model requests and 1,796 tool calls; the session ran 43.7 hours in all.
- **Review.** 5,314 review decisions since review records began (2026-11-10 18:34); 42 of the 75 denials were real risks after checking each one. The others were cancelled runs, rule false positives and human or cache decisions.
- **Terminal-Bench 2.1.** Sakura Code scored 75/88 (Pass@1 85.23%) in one local run. It is Sakura Code's result, not the framework's, and not a leaderboard score.

## Sakura Code

[`sakuracode`](code/README.md) is a terminal coding agent built on this SDK: `npm install -g sakuracode`. Its commands, keys, permission presets, configuration and ACP support are documented in [code/README.md](code/README.md).

## Reference

<details>
<summary>Plugins</summary>

| Plugin | What it does | In `corePlugins()` |
|---|---|---|
| `tools` | `read`, `write`, `edit`, `bash` (background commands, `sleep N` waits, long output saved to a file) | yes |
| `context` | loads `AGENTS.md` as pinned instructions and reloads it after compaction | yes |
| `resilience` | asks again when a reply was cut off before any text, came back empty, or (optionally) was cut mid-text | yes |
| `limits` | turn, token, cost and run-time budgets; pauses on quota errors | yes (unlimited) |
| `review` | reviews risky tool calls: hard rules, extra authorizers, a reviewer model, or a person (`manual`) | no |
| `redaction` | swaps secrets for stable placeholders before a request leaves and restores them in the reply | no |
| `agents` | `delegate`, `agent_view`, `agent_stop` for sub-agents; enabled with `subAgents` | no |
| `toolset` | BM25 tool search, an MCP client (stdio) and code mode; enabled with `mcp` | no |

`bundle("safety", [redaction, review])` makes one plugin of two. `createAgent` installs each plugin once, orders them by `requires`, and fails at creation on a missing requirement, a cycle or a duplicate name.

</details>

<details>
<summary>The <code>sakura</code> command line</summary>

```sh
sakura run "Read README.md and summarize it" --tools read --session .sakura/demo.jsonl
sakura resume --tools read --session .sakura/demo.jsonl
sakura --help
```

Set `DEEPSEEK_API_KEY` or `SAKURA_API_KEY` first. The CLI starts with no tools unless you pass `--tools`. Add `--json` for JSON lines, or `--cwd`, `--base-url`, `--model` and `--context-window` to configure the run.

</details>

<details>
<summary>Frequently asked questions</summary>

**How does it recover from a crash?** The session file is append-only and a message is written only when it is complete. Run the agent again on the same file: a read-only call that was open runs again, a command that may have half run gets an "interrupted, check the current state" result, and a torn last line is repaired when the file is opened.

**Can I compact or rewind the conversation?** Compaction starts by itself near the end of the model's window; `agent.run(undefined, { compact: true })` does it now. `agent.rewindTo(entryId)` starts a new branch in the same file; `agent.fork(path, entryId)` copies the conversation up to that point into a new file.

**Can the model run a command in the background?** Yes. `bash` takes `background: true`, and a command still running after 120 seconds moves to the background by itself. The model is told when it ends and can ask to be woken up then.

**How are secrets kept from the model?** `redactionPlugin` replaces secrets with stable placeholders in every request and restores them before a tool runs; `redaction.wrap(llm)` protects the reviewer model too. It protects what is sent to the provider, not what is stored locally: use `redaction.scrub(text)` before sharing session files or traces.

**Does it support MCP?** As a client over stdio. Tools can be declared directly, found through BM25 search, or called from a code-mode script, where every call is still reviewed one by one when `review` is installed.

**Which models work?** Anything that speaks Chat Completions with streaming and tool calls (tried with DeepSeek, Kimi and OpenCode Go).

</details>

## Development

```sh
npm ci
npm run check          # boundaries, types, lint, format, then all tests
npm run test:unit      # one package at a time
npm run test:contract  # one suite against every implementation of an interface
npm run example        # the quick-start example with a scripted model
npm run build          # compile the SDK and CLI into dist/
```

None of the tests calls a real model.

## License

MIT, see [LICENSE](LICENSE). Code and text taken from other projects (Pi, OpenAI Codex, gitleaks) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with their licences in [`licenses/`](licenses/).
