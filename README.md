# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

**Sakura is a small TypeScript framework for building coding agents.** A stateless kernel of about 1,200 lines runs the agent loop and offers eight hooks. Everything else (file and shell tools, project instructions, budgets, automatic review, secret redaction, sub-agents, MCP, code mode) is an optional plugin. It ships as the `sakura-agent` npm package, with an SDK and a small `sakura` command-line tool.

It started as one person's own agent architecture and is published so that others can read it, use it, or take it apart. It makes no claim to be the most complete agent framework. Its aim is to stay small and readable and to keep the safety features switchable.

## At a glance

- **What it is:** a library for TypeScript code, plus a minimal CLI (`sakura run`, `sakura resume`).
- **Runtime:** Node.js 26 or newer. TypeScript sources are run directly in development; the npm package ships compiled JavaScript.
- **Models:** any OpenAI-style Chat Completions endpoint (tried with DeepSeek, Kimi and OpenCode Go). One wire protocol, with per-model compatibility switches.
- **Kernel:** a stateless loop, eight hooks, three interfaces (`LlmClient`, `Log`, `Environment`), conversation compaction and goals.
- **Persistence:** an append-only, tree-shaped JSONL session file. A crashed run continues from the same file.
- **Plugins on by default:** `tools`, `context`, `resilience`, `limits`. **Opt in:** `review`, `redaction`, sub-agents, MCP client, tool search, code mode.
- **Safety plugins fail closed:** if the review or the redaction cannot do its job, the action or request does not go ahead.
- **License:** MIT.

## Who it is for

- You want an agent loop you can read in one sitting and change without a plugin marketplace.
- You want review and secret redaction as separate, testable pieces rather than flags inside a monolith.
- You want to run an agent inside your own application and control its model, session and tools from code.

It is not a ready-made product with a user interface, and it does not ship a sandbox: the default local environment uses the permissions of the calling process, so run untrusted work in an isolated environment of your own.

## How it is built

```
kernel          the loop, 8 hooks, 3 interfaces (LlmClient, Log, Environment), compaction, goals
session         the conversation log: in memory, or a JSONL file (tree-shaped, single writer, repairs a torn last line)
llm             one protocol (Chat Completions): retries, resend after a dropped stream, stall detection
env             where tools run: the local machine, or a remote runner you provide
agent           createAgent(): assembles the above with a default plugin set
plugins/*       tools, context, resilience, limits, review, redaction, agents, toolset
```

- **The kernel keeps no state.** It reads the log, asks the model, runs tools, appends to the log. A crash is recovered by running again on the same log. Tools marked `replay: "never"` get an "interrupted" result instead of being run twice.
- **Eight hooks are all a plugin gets:** `context`, `request`, `tool.before`, `tool.run`, `tool.after`, `turn.end`, `error`, `event`. A plugin is `{ name, compensates?, setup(api), prepare?, afterCompaction? }`. `compensates` says which weakness of today's models the plugin works around, so it can be deleted when that weakness is gone.
- **Packages depend in one direction** (kernel ← infrastructure ← plugins ← agent) and plugins never import each other. A script checks this (`npm run check:boundaries`), together with a ceiling on how many names a package exports and a ban on import cycles.

| Plugin | What it does | On by default |
|---|---|---|
| `tools` | `read`, `write`, `edit`, `bash` (background commands, `sleep N` waits, long output saved to a file) | yes |
| `context` | loads `AGENTS.md` as pinned instructions, reloads it after compaction | yes |
| `resilience` | asks the model again when a reply was cut off before it wrote anything (a reasoning model that used its whole output limit thinking), came back empty, or (optionally) was cut in the middle of its text. Each fix can be switched off | yes |
| `limits` | turn, token, cost and run-time budgets (the run time is checked between turns, not during one); pauses on quota errors | yes (unlimited) |
| `review` | automatic review of risky tool calls: hard rules, extra authorizers, a reviewer model; fails closed | no |
| `redaction` | swaps secrets for stable placeholders before a request leaves, restores them in the reply | no |
| `agents` | `delegate`, `agent_view`, `agent_stop` for sub-agents (they inherit review and redaction); enabled with the `subAgents` option | no |
| `toolset` | BM25 tool search, an MCP client (stdio), code mode (scripts that call several tools, run in an isolated JavaScript runtime); enabled with the `mcp` option | no |

## Install and run

```sh
npm install sakura-agent
```

```ts
import { compatPresets, createAgent } from "sakura-agent";

const agent = await createAgent({
  cwd: process.cwd(),
  model: { baseUrl: "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY!, model: "deepseek-flash", contextWindow: 128_000, compat: compatPresets.deepseek },
  tools: ["read"],
  sessionFile: ".sakura/session.jsonl", // omit to keep the conversation in memory
});
try {
  const run = agent.run("Summarize README.md.");
  for await (const event of run.events) {
    if (event.type === "tool_start") console.log("tool:", event.call.name);
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") console.log(part.text);
    }
  }
  console.log((await run.result).reason); // "done" | "cancelled" | "paused" | "error"
} finally {
  await agent.close(); // always: it stops commands still running in the background and releases the session file
}
```

To resume, create an agent with the same `sessionFile` and call `agent.run()` without a prompt.

Turning on the safety plugins and sub-agents:

```ts
import { corePlugins, createAgent, redactionPlugin, reviewPlugin } from "sakura-agent";

const redaction = redactionPlugin({ key: "stable-key" });
// `model` and `reviewerModel` are model settings or clients, as in the first example
const agent = await createAgent({
  model,
  plugins: [...corePlugins(), redaction, reviewPlugin({ llm: redaction.wrap(reviewerModel) })], // the reviewer must not see secrets either
  subAgents: {},                                                                                // sub-agents get the same plugins
  mcp: { servers: { files: { command: "npx", args: ["some-mcp-server"] } }, expose: "codemode" },  // script calls are reviewed too
});
```

Plugins can contain plugins: `bundle("safety", [redaction, review])` is one plugin made of two, and `createAgent` installs each plugin once, orders them by `requires`, and fails at creation on a missing requirement, a cycle or a duplicate name.

## The command line

```sh
sakura run "Read README.md and summarize it" --tools read --session .sakura/demo.jsonl
sakura resume --tools read --session .sakura/demo.jsonl
sakura --help
```

Set `DEEPSEEK_API_KEY` or `SAKURA_API_KEY` first. The CLI starts with no built-in tools unless you pass `--tools`. Add `--json` for JSON lines, or `--cwd`, `--base-url`, `--model` and `--context-window` to configure the run.

## Frequently asked questions

**How does it recover from a crash?** The session file is append-only and a message is written only when it is complete. Run the agent again on the same file: a read-only call that was open is simply run again, a command that may have half run gets an "interrupted, check the current state" result instead of running twice, and a torn last line is repaired when the file is opened.

**Can I go back to an earlier point in a conversation?** Yes, in two ways. `agent.rewindTo(entryId)` goes back inside the same session file: what is said next starts a new branch, and the old one stays in the file. `agent.fork(path, entryId)` copies the conversation up to that point into a new session file, which you open with `createAgent({ sessionFile: path })`; the original is not changed and both can go on. A fork never cuts a turn in two: the results of the tool calls of the last message come with it.

**Can the model run a command in the background?** Yes. `bash` takes `background: true`, and any command still running after 120 seconds moves to the background by itself. The model is told the process id and the output file, and is told when the command ends. It can ask to be woken up when that happens (`wake: true` on the `bash` call, or `wake: false` to say it does not need to be); the application sets the default with the `wake` option of `createAgent`. Always call `agent.close()`: a command left running keeps the Node process alive, and `close()`, Ctrl-C and `process.exit` stop it.

**How are secrets kept from the model?** The `redaction` plugin replaces secrets (a rule table derived from gitleaks plus a few generic rules) with stable placeholders in every request, restores them in the reply before a tool runs, and refuses to send a request if scanning fails. `redaction.wrap(llm)` gives the reviewer model the same protection. It does not stop a command you let the agent run from reading the environment of its own process.

**What does automatic review check?** Hard rules first (read-only commands that stay inside the working directory pass, catastrophic ones such as deleting the root are refused; a read-only command that points outside the working directory goes on to the reviewer), then optional extra authorizers, then a reviewer model that scores risk against the user's authorization. A refusal goes back to the agent as a tool error so it can try another way. Any failure of the review itself is a refusal. Review is a safety net, not a sandbox: it reads the text of a command, so it cannot follow a symbolic link and does not confine file access.

**What if a reasoning model uses its whole output limit thinking?** The reply comes back cut off (`finish_reason: length`) with no text. The `resilience` plugin, on by default, notices this, asks the model to continue and raises `max_tokens` (doubling, up to 32768) for the next request. After two retries it lets the run end. Empty replies are asked once more. `resiliencePlugin({ cutEmpty: false })` switches a fix off.

**Does it support MCP?** As a client over stdio. Tools can be declared directly, found through BM25 search, or called from a code-mode script.

**What is code mode, and why does a script's call need review when the script already runs in an isolated runtime?** In code mode the model writes one small JavaScript program that calls several tools, instead of making one call per request. The program runs in an isolated JavaScript runtime (QuickJS compiled to WebAssembly), which keeps the *program itself* away from the machine. This is not a sandbox for commands. The tools it calls (a shell command, a file write, an MCP tool) run outside that runtime with their full power, so a call made from a script is exactly as risky as the same call made directly. Calls from a script do not pass the loop's hooks, so the review is asked explicitly: with the `review` plugin installed every call a script makes is reviewed one by one (the script as a whole is not reviewed again), and a refusal becomes an error inside the script. Without it, every call simply runs, as a direct call would.

**Where do tools run?** In an `Environment`. `createLocalEnvironment()` uses the calling process's permissions. `createRemoteEnvironment({ cwd, run })` sends commands to a runner you provide, for example a container. It is an adapter, not a sandbox. On this machine a timeout, a cancel and exit stop a command together with everything it started, but not a process that starts a session of its own (with `setsid`, for example); to stop everything, run the commands in a container. Long command output and remote scripts are saved under `.sakura/` in the working directory.

**Which models work?** Anything that speaks Chat Completions, including streaming and tool calls. Compatibility switches cover the differences between providers (field names, reasoning content, image handling).

## Development

```sh
npm ci
npm run check          # boundaries, types, lint, format, then all tests
npm run test:unit      # one package at a time (packages/*/test)
npm run test:contract  # one suite run against every implementation of an interface
npm run test:tools     # repository rules: dependency direction, export ceilings, no cycles
npm run example        # the quick-start example with a scripted model
npm run build          # compile the SDK and CLI into dist/
```

None of the tests calls a real model.

## License

MIT, see [LICENSE](LICENSE). Code and text taken from other projects (Pi, OpenAI Codex, gitleaks) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with their licences in `licenses/`. The earlier Python source is kept in the repository history.
