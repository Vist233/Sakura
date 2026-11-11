# Sakura

[English](README.md) · [简体中文](README.zh-CN.md)

**Sakura is the Codex-style coding agent as a library.** The whole loop (tools, sessions, compaction, goals, review, sub-agents) lives in code you own, so defining an agent for one specific job, or starting a fleet of them, takes a few lines instead of a configuration project with plugin switches. It is written in TypeScript and published on npm as `sakura-agent`, with an SDK and a small `sakura` command-line tool; the terminal built on the same SDK is [`sakuracode`](code/README.md).

```ts
import { createAgent } from "sakura-agent";

const agent = await createAgent({ model });          // this one line
const run = agent.run("Add tests for parse() and make them pass.");
```

That one line already gives a complete Codex-style agent: the `read`, `write`, `edit` and `bash` tools, project instructions (`AGENTS.md`), automatic compaction when the context fills, automatic recovery from replies that were cut off or came back empty, and budgets you can set. Give it a `sessionFile` to resume, fork and rewind; give it a `goal` to have it keep working toward one.

## Why Sakura

**You own the complete inside of a Codex-style agent, instead of using a finished product you cannot change.** Everything else follows from that.

### 1. One line to start, and the default is complete

You do not pick plugins first. The default set is what a command-line agent needs; when you want more (review, redaction, sub-agents, MCP), each is one more line.

### 2. Specialising an agent means changing parameters, not flipping switches

A purpose is a few parameters: the directory the agent works in, the tools it gets, what it is told, and what it has to achieve.

```ts
// a read-only reviewer
await createAgent({ model, tools: ["read"], rules: ["Review only; do not change any file."] });

// an agent with a goal and a check: it may not stop while the check fails
await createAgent({ model, goal: { objective: "Make all tests pass", verify: "npm test" } });

// tools running on another machine, with automatic review of what runs there
const environment = await createSshEnvironment({ host: "agent@box", cwd: "/srv/job" });
await createAgent({ model, environment, plugins: [...corePlugins(), reviewPlugin({ llm: reviewerModel })] });

// an agent that can hand work to sub-agents (they inherit review and redaction)
await createAgent({ model, subAgents: {} });
```

### 3. A fleet of agents is cheap

An agent is an object: its own working directory, its own `Environment`, its own session file, and nothing read from the process's current directory. So a fleet is an array and `Promise.all`:

```ts
const results = await Promise.all(
  jobs.map(async (job) => {
    const agent = await createAgent({ model, cwd: job.dir, confine: true, tools: job.tools, rules: job.rules, sessionFile: job.session });
    const run = agent.run(job.task);
    for await (const _event of run.events) {} // write the events to your own log here
    return (await run.result).reason;
  }),
);
```

A complete example you can run is [`examples/fleet.ts`](examples/fleet.ts) (a scripted model when there is no API key, so it works offline: `npm run example:fleet`): three agents for documentation, tests and review, each in its own directory and all running at once; the read-only review agent cannot have written a file.

### 4. Where it can reach, who reviews it and what it may spend are options in your code

- **Where it can reach:** `confine: true` keeps the file tools inside the directory however a path is written (absolute, `..`, a link); `createSshEnvironment` runs the tools on another machine over one SSH login; any function that can run a shell command can be an environment.
- **Who reviews it:** the `review` plugin judges risky tool calls with hard rules, then a reviewer model, and a circuit breaker stops a run that keeps being refused; every decision is recorded in the session log. Agents can run unattended. An agent with no shell (file tools plus a checker that answers true or false) needs nothing more than its confined directory, so no second model has to run.
- **What it may spend:** `limits` covers turns, tokens, cost and run time.

## How it compares

Tools such as Codex CLI and pi are finished products you use as they are; Sakura gives you the parts inside such a product, to take apart, recombine and put into your own product or a fleet of agents. The comparison is from their public documentation (November 2026).

| | Codex CLI | pi | Sakura |
|---|---|---|---|
| What it is | a terminal agent product; `exec --json` for automation; can run as an MCP server | a "minimal, extensible agent harness"; interactive, print/JSON and RPC modes, a TypeScript SDK | a library first: the whole agent is in your code; with a minimal CLI and a separate terminal |
| Keeping actions safe | sandbox modes (read-only, workspace-write, full access) and approval policies | not described in its README | a reviewer with hard rules and a breaker, no person needed; `confine` for the file tools; no sandbox of its own |
| Sub-agents, plan mode | not checked | left out by design | sub-agents built in (opt-in) |
| Where the tools run | this machine, in a sandbox | not described in its README | this machine, SSH, or any function, chosen per agent |
| Models | OpenAI models by default | built-in providers via `/login` | any Chat Completions endpoint (tried with DeepSeek, Kimi, OpenCode Go) |

Sources: [Codex CLI documentation](https://developers.openai.com/codex), [pi README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Check them for current details; both move quickly.

## Who it is for

- You want to define an agent in code and control its model, session, tools and reach from there.
- You want many agents, each with a specific job: batch work, remote machines, or an agent inside your own product, running without anyone watching.
- You want review and secret redaction as separate, testable pieces rather than flags inside a monolith, and a loop you can read in one sitting.

It is not an all-in-one assistant for your own laptop (for that, use [`sakuracode`](code/README.md): `npm install -g sakuracode`), and it does not ship a sandbox: the default local environment uses the permissions of the calling process. `confine` is a boundary for the file tools, not for a shell: a shell command can still reach anything, so give an agent a shell only together with the review, or run untrusted work in an isolation you provide yourself.

## Where an agent can reach

```ts
import { createAgent, createSshEnvironment, corePlugins, reviewPlugin } from "sakura-agent";
import type { Tool } from "sakura-agent";

// a tool is a plain object
const checkProof: Tool = {
  name: "check_proof",
  description: "Check proof.txt. Answers true or false.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  effect: "read",
  async execute(_args, { env }) {
    const proof = new TextDecoder().decode(await env.readFile("proof.txt"));
    return { content: [{ type: "text", text: String(proof.includes("QED")) }] };
  },
};

// 1. no shell, confined to its directory: no reviewer is needed
const prover = await createAgent({ model, cwd: "/work/job-17", confine: true, tools: ["read", "write", "edit", checkProof] });

// 2. the same loop, with the tools on another machine, and a reviewer for what it runs there
const environment = await createSshEnvironment({ host: "agent@box", cwd: "/srv/job-17" });
const remote = await createAgent({ model, environment, plugins: [...corePlugins(), reviewPlugin({ llm: reviewerModel })] });
```

## What we measured

Numbers from real runs, each with the conditions it was taken under. They describe those runs; they are not guarantees, and provider behaviour can change.

| What | Result | Conditions |
|---|---|---|
| Prompt cache | The median request read **98.8 %** of its input from the provider's cache; 95.7 % of all input tokens (97.7 % without the first request after each compaction) | One real coding session on `deepseek-v4.1-flash` via OpenCode Go: 20.8 hours, 1,817 model requests. Compaction and review requests are not counted. Caching is done by the provider |
| Long unattended run | **20.8 hours**, 1,817 model requests, 1,766 tool calls, no provider error and no crash; the process stayed at about 160 MB | The same session, measured over those first 20.8 hours |
| Automatic review | **445** reviewed calls in the next 15 hours: **0** technical failures of the reviewer, 2 refusals (a cancelled run, and an `rm -rf` of the working directory) | The same session after the reviewer's conversation was bounded and a failed review is retried once. Before that, 9 reviews failed technically because the reviewer's own conversation had grown too long |
| Benchmark | No complete Terminal-Bench 2.1 score yet, so none is published | A partial run exists; it is not a score |

One limit to know: later in that same session, an error the provider sent inside a stream stopped the run once. Such errors are now classified like the same error as an HTTP status and retried.

## At a glance

- **What it is:** a library for TypeScript code, plus a minimal CLI (`sakura run`, `sakura resume`) and, in the repository, a terminal.
- **Runtime:** Node.js 26 or newer. TypeScript sources are run directly in development; the npm package ships compiled JavaScript.
- **Models:** any OpenAI-style Chat Completions endpoint (tried with DeepSeek, Kimi and OpenCode Go). One wire protocol, with per-model compatibility switches.
- **Kernel:** a stateless loop, eight hooks, three interfaces (`LlmClient`, `Log`, `Environment`), conversation compaction and goals.
- **Persistence:** an append-only, tree-shaped JSONL session file. A crashed run continues from the same file.
- **Plugins on by default:** `tools`, `context`, `resilience`, `limits`. **Opt in:** `review`, `redaction`, sub-agents, MCP client, tool search, code mode.
- **Safety plugins fail closed:** if the review or the redaction cannot do its job, the action or request does not go ahead.
- **Tests:** over 5,000 tests in the public tree, contract suites that run one test set against every implementation of an interface, and live tests against real models and a real SSH server.
- **License:** MIT.

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

**Can I compact the conversation myself?** Yes. Compaction starts by itself when the context is within 17% of the model's window (and never less than 16384 tokens from it), and `agent.run(undefined, { compact: true })` does it now, whatever the size: it summarises the older part, keeps the recent part word for word, and says so with a `compaction` event (there is none when there was nothing worth summarising). `agent.run("next question", { compact: true })` compacts first and then answers, and the new question is not part of the summary.

**Can I go back to an earlier point in a conversation?** Yes, in two ways. `agent.rewindTo(entryId)` goes back inside the same session file: what is said next starts a new branch, and the old one stays in the file. `agent.fork(path, entryId)` copies the conversation up to that point into a new session file, which you open with `createAgent({ sessionFile: path })`; the original is not changed and both can go on. A fork never cuts a turn in two: the results of the tool calls of the last message come with it.

**Can the model run a command in the background?** Yes. `bash` takes `background: true`, and any command still running after 120 seconds moves to the background by itself. The model is told the process id and the output file, and is told when the command ends. It can ask to be woken up when that happens (`wake: true` on the `bash` call, or `wake: false` to say it does not need to be); the application sets the default with the `wake` option of `createAgent`. Always call `agent.close()`: a command left running keeps the Node process alive, and `close()`, Ctrl-C and `process.exit` stop it.

**How are secrets kept from the model?** The `redaction` plugin replaces secrets (a rule table derived from gitleaks plus a few generic rules) with stable placeholders in every request, restores them in the reply before a tool runs, and refuses to send a request if scanning fails. `redaction.wrap(llm)` gives the reviewer model the same protection. It protects what is sent to the model provider, not what is stored on this machine: the session file, the events and any trace keep the real values (the tools need them, and a resumed session is read from that file), so mask them with `redaction.scrub(text)` before you export or share them. It does not stop a command you let the agent run from reading the environment of its own process.

**What does automatic review check?** Hard rules first (read-only commands that stay inside the working directory pass, catastrophic ones such as deleting the root are refused; a read-only command that points outside the working directory goes on to the reviewer), then optional extra authorizers, then a reviewer model that scores risk against the user's authorization. A refusal goes back to the agent as a tool error so it can try another way. Any failure of the review itself is a refusal. Review is a safety net, not a sandbox: it reads the text of a command, so it cannot follow a symbolic link and does not confine file access.

**What if a reasoning model uses its whole output limit thinking?** The reply comes back cut off (`finish_reason: length`) with no text. The `resilience` plugin, on by default, notices this, asks the model to continue and raises `max_tokens` (doubling, up to 32768) for the next request. After two retries it lets the run end. Empty replies are asked once more. `resiliencePlugin({ cutEmpty: false })` switches a fix off.

**Does it support MCP?** As a client over stdio. Tools can be declared directly, found through BM25 search, or called from a code-mode script.

**What is code mode, and why does a script's call need review when the script already runs in an isolated runtime?** In code mode the model writes one small JavaScript program that calls several tools, instead of making one call per request. The program runs in an isolated JavaScript runtime (QuickJS compiled to WebAssembly), which keeps the *program itself* away from the machine. This is not a sandbox for commands. The tools it calls (a shell command, a file write, an MCP tool) run outside that runtime with their full power, so a call made from a script is exactly as risky as the same call made directly. Calls from a script do not pass the loop's hooks, so the review is asked explicitly: with the `review` plugin installed every call a script makes is reviewed one by one (the script as a whole is not reviewed again), and a refusal becomes an error inside the script. Without it, every call simply runs, as a direct call would.

**Where do tools run?** In an `Environment`. `createLocalEnvironment()` uses the calling process's permissions. `createRemoteEnvironment({ cwd, run })` sends commands to a runner you provide, for example a container. It is an adapter, not a sandbox. `createSshEnvironment({ host, cwd })` is that adapter for a machine you can reach with ssh: it logs in once, runs every command over that connection, and tells the model in the system prompt that its tools run elsewhere and that the connection can fail (when it does, the tool result says so and where the command's output is; it never reports a lost connection as a finished command). Authentication and host keys are whatever your ssh configuration does; the remote machine needs `bash`, `base64` and `setsid`, so Linux rather than macOS. On this machine a timeout, a cancel and exit stop a command together with everything it started, but not a process that starts a session of its own (with `setsid`, for example); to stop everything, run the commands in a container. Long command output and remote scripts are saved under `.sakura/` in the working directory.

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
