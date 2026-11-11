# sakuracode

[English](README.md) · [简体中文](README.zh-CN.md)

**sakuracode is an open-source terminal coding agent (a command-line AI coding assistant).** It reads and edits your code, runs shell commands and tests, and works toward a goal on its own, using any model endpoint that speaks Chat Completions (you choose it in a config file; DeepSeek and OpenCode Go are built in as examples). Every tool call is checked by an automatic review before it runs. It is built on the [Sakura agent framework](../README.md) (npm package `sakura-agent`) and is similar in use to OpenAI Codex CLI and Claude Code.

```bash
npm install -g sakuracode
export MY_API_KEY=...   # the key of the endpoint you set up in ~/.sakura/config.toml (see below)
sakuracode "explain this repository"
```

* Interactive inline session: your terminal's scrollback is kept, the prompt and the status line stay on the last rows of the window. A big paste is shown as `[Pasted Content N chars]` and sent in full.
* Replies are rendered as **Markdown** (headings, lists, tables, fenced code, links). `exec` writes Markdown too.
* Slash commands, `!shell`, `@file` mentions, resume, fork, undo, `/compact`, long-running goals (`/goal`), MCP servers, image input.
* Steer, queue or cancel while the agent works.
* `exec` mode for scripts and CI, with a `--json` event stream; config file with profiles.
* Automatic review of every tool call (hard rules, then a reviewer model); every decision is recorded in the session file.
* Long sessions: the conversation is compacted when the context fills, and sessions can be resumed later.
* Not tied to a provider: any Chat Completions endpoint is set up in the config file; DeepSeek and OpenCode Go are built in for convenience.

## Defaults

| | |
|---|---|
| Working directory | The agent starts in the directory where you launched the command and **may go anywhere**. Nothing is restricted to the directory and no outside-directory rule is enabled. (`-C DIR` only changes where it starts.) |
| Review | **On.** Every tool call goes through the framework's review plugin: hard rules first, then a reviewer model. A refused call goes back to the agent as a tool error. There is no approval prompt: the review decides on its own. |
| Redaction | **Off.** Turn it on with `--redact`, `redaction = true` in the config, or `/redaction on`. It hides secrets from the model provider; the session file on disk keeps the real values. |
| Output | Markdown. |

### Is it safe to let it run commands?

It is **not sandboxed**: the agent runs with your user's permissions and may read and change files anywhere you can, and run any command. What stands between it and your machine is the automatic review (hard rules first, then a reviewer model), which checks writes, command expansions, credential access and catastrophic patterns, refuses what it judges harmful, and records every decision in the session file. A review is a judgement, not a wall: for untrusted work run sakuracode inside a container or virtual machine you provide. The conversation, including the content of files the agent reads, is sent to the model provider you chose (the reviewer is a second request to the same provider unless you configure another); with `--redact`, secrets are replaced by placeholders before a request leaves, while the session file on your disk keeps the real values.

## Install and run

Requires Node 26 or newer (older versions print an npm warning).

```bash
npm install -g sakuracode
```

### First start: tell it which model to use

sakuracode is not tied to one provider. It works with any endpoint that speaks Chat Completions (streaming and tool calls). You describe your endpoint once in `~/.sakura/config.toml`; the API key stays in an environment variable and is never stored by sakuracode.

```bash
mkdir -p ~/.sakura
cat > ~/.sakura/config.toml <<'EOF'
provider = "myprovider"

[providers.myprovider]
base_url = "https://api.example.com/v1"   # your endpoint
model = "your-model-name"
key_env = "MY_API_KEY"                    # the environment variable that holds the key
context_window = 128000                   # the model's context window, in tokens
compat = "deepseek"                       # a compatibility preset: deepseek, moonshot, openai
# headers = { "x-team" = "a" }            # extra request headers, if your endpoint wants them
# session_header = "x-session-id"         # a header that gets the session id, if it wants one
EOF
export MY_API_KEY=...
cd your-project
sakuracode "explain this repository"
```

`context_window` matters: the status line and automatic compaction count against it. `sakuracode providers` shows which providers are known and whether their key is set (never the key itself). It creates `~/.sakura/sessions/` on the first start.

**Example: OpenCode Go.** This is the configuration used while developing sakuracode; any other endpoint is set up the same way:

```toml
provider = "opencode"

[providers.opencode]
base_url = "https://opencode.ai/zen/go/v1"
model = "deepseek-v4.1-flash"
key_env = "OPENCODE_API_KEY"
context_window = 1000000
compat = "deepseek"
images = true
session_header = "x-opencode-session"   # OpenCode Go refuses a request without a session id
```

For convenience, DeepSeek and OpenCode Go are also built in: with only `DEEPSEEK_API_KEY` or `OPENCODE_API_KEY` set and no config file, sakuracode uses their built-in settings (a 128,000-token window) and picks the first one whose key is set. `--provider NAME` picks a provider for a single run.

If something is missing, it says what to do:

| Situation | What you see | Exit code |
|---|---|---|
| No key set for any provider | `no API key found; set one of: ...` | 2 |
| The provider you chose has no key | `provider "myprovider" needs the environment variable MY_API_KEY` | 1 |
| Interactive command in a pipe or script | `the interactive session needs a terminal; use sakuracode exec for pipes and scripts` | 2 |

### Commands

```bash
sakuracode                          # interactive session
sakuracode "fix the failing test"   # interactive, the prompt is sent at once
sakuracode --provider opencode      # choose the provider
sakuracode -i error.png "what does this error mean?"   # attach an image
sakuracode resume --last            # continue the latest session (a picker without --last)
sakuracode fork --last              # copy the latest session into a new one
sakuracode review --base main       # review the changes against main, print the review
sakuracode exec "summarise this repo"            # one run, Markdown on stdout
sakuracode exec --json "list the TODOs" | jq .   # events as JSON lines
echo "explain this error" | sakuracode exec -    # prompt from stdin
sakuracode sessions                 # list sessions
sakuracode providers                # providers and whether their key is set (never the key)
sakuracode acp                      # serve the Agent Client Protocol on stdin/stdout (see below)
```

### Options

| Option | Meaning |
|---|---|
| `--provider NAME` | `deepseek`, `opencode`, or a provider from the config file |
| `-p, --profile NAME` | settings profile from the config file |
| `-m, --model NAME` | model of the provider |
| `--permissions NAME` | `auto` (default), `read-only`, `strict`, `full-access` |
| `-i, --image FILE[,FILE]` | attach images to the first prompt (png, jpg, gif, webp, bmp); `@pic.png` in a prompt or a dropped file path does the same |
| `--redact` / `--no-redact` | redaction on / off (default off) |
| `--thinking LEVEL` | `off`, `low`, `medium`, `high` |
| `--max-tokens N` | output limit per model request |
| `-C, --cwd DIR` | directory to start in |
| `--resume REF` | continue a session (id, id prefix, `last`) |
| `--json` | `exec`: events as JSON lines (first line `session`, last line `result`) |
| `--raw` | `exec`: write the Markdown as it is even on a terminal |
| `-q, --quiet` | `exec`: no progress lines on stderr (warnings and errors are still shown) |
| `--output-last-message FILE` | `exec`: also write the final reply to FILE |
| `--no-color` | no colours |

`exec` exit codes: 0 done, 1 error, 2 usage error or paused by the review breaker, 130 cancelled. In `exec`, progress goes to stderr (one line per tool call) and the final reply goes to stdout; on a terminal it is rendered, in a pipe it is the raw Markdown.

## In the session

| Key | While idle | While the agent works |
|---|---|---|
| Enter | send | **steer**: delivered before the agent's next model request |
| Tab | complete a slash command | **queue**: handled when the agent would stop |
| Shift-Tab | switch the review mode: auto, strict, read-only (`full-access` only with `/permissions`) | applied when the run ends |
| Esc | close the popup | **cancel** the run |
| Ctrl-C | clear the prompt; twice on an empty prompt leaves | cancel the run |
| Ctrl-D | leave (empty prompt) | |
| Shift-Enter, Alt-Enter, Ctrl-J, or `\` then Enter | new line in the prompt | |
| Up / Down | history, or move between lines | |
| Ctrl-A/E/K/U/W/Y, Alt-arrows | readline-style editing | |

Messages typed during a run show above the prompt as "steering" or "queued" until the agent takes them.

### Slash commands

| Command | |
|---|---|
| `/help` | list the commands |
| `/status` | session, directory, model, permissions, context left, input (cached and new), cache hit rate, output |
| `/model [provider[/model]]` | show or switch provider and model (the agent is closed and recreated on the same session file) |
| `/permissions [auto\|read-only\|strict\|full-access]` | show or change what is reviewed |
| `/redaction [on\|off]` | hide secrets from the model |
| `/rename <name>` | give the session a name |
| `/compact` | summarise the conversation to free context |
| `/new`, `/clear` | start a new session (`/clear` also clears the screen) |
| `/resume [id\|last]` | continue an earlier session (a picker without argument) |
| `/fork` | copy this session into a new one and continue there |
| `/undo` | go back to before your last message and put it back in the prompt (Esc twice on an empty prompt does the same) |
| `/init` | have the agent write an `AGENTS.md` |
| `/review [focus]` | have the agent review the uncommitted changes |
| `/diff` | show `git diff` |
| `/goal [objective\|clear]` | show the goal; with text, set it and start working on it; `clear` ends it |
| `/mcp` | show MCP servers |
| `/exit`, `/quit` | leave |

`!command` runs a shell command yourself and shows the output (the agent does not see it). `@path` in a prompt names an existing file or directory to the agent.

### Permission presets

| Preset | |
|---|---|
| `auto` (default) | review on |
| `read-only` | review on, and the agent only gets the `read` tool |
| `strict` | review on; three refusals in a row pause the run |
| `full-access` | review off |

None of them restricts the working directory: the review plugin runs with `directoryRules: false`, so a path outside the launch directory is not a reason to refuse. Writes, command expansions, credentials and catastrophic patterns are still checked by the hard rules and the reviewer model.

## Use with T3 Code and other ACP clients

`sakuracode acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, version 1) on stdin and stdout, so an ACP client can run it as its coding agent. Stdout carries only protocol messages; logs go to stderr (`SAKURACODE_ACP_LOG=off|error|warn|info|debug`, default `warn`).

**T3 Code:** Settings, Providers, Add provider, Show more, **Local ACP command**. Fill in the form like this.

Use **absolute paths** everywhere: T3 Code starts the command from its own working directory, so a relative path fails, and a desktop app often has a shorter `PATH` than your shell. Find the paths in a terminal with `which node` and `which sakuracode` (or `npm root -g`).

| Field | Value |
|---|---|
| Name | `Sakura Code` (any name) |
| Executable | the absolute path of `node`, for example `/opt/homebrew/bin/node` |
| Arguments | one row each: `--disable-warning=ExperimentalWarning`, then the absolute path of `sakuracode.mjs` (for a global install: `<npm root -g>/sakuracode/dist/code/bin/sakuracode.mjs`; in a checkout: `<repo>/code/bin/sakuracode.mjs`), then `acp` |
| Environment | the key of your provider, for example `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY` or `COMMANDCODE_API_KEY` (a desktop app does not see the variables of your shell) |

If your `PATH` is complete in the app, the executable can be the absolute path of the `sakuracode` command (`which sakuracode`) with the single argument `acp`.

Then start a chat with that provider. To check it by hand, run `sakuracode acp` and paste `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}` followed by Enter: one JSON line comes back.

The model picker lists every provider in `~/.sakura/config.toml` (and the built-in ones); picking one switches the chat to it on the same conversation. The thinking selector appears for models with a reasoning effort. A review-mode selector offers `auto`, `read-only` and `strict`; `full-access` (nothing is reviewed) is offered only if you start the agent with `--permissions full-access` in the arguments. A provider whose key is not set is listed with the variable to set.

What works now: chat with streamed replies and reasoning, cancelling a running turn, several chats at once (one prompt at a time in each). New chats use the review mode `auto` (every call is reviewed); `--permissions strict` or `read-only` after `acp` changes it, and `full-access` only runs when you ask for it on that command line. Tool calls show as cards (reads, edits with diffs, commands with output), the context meter follows each reply, and an idle chat is compacted in the background after the cache lifetime (the same `auto_compact_*` and `cache_ttl_minutes` settings as the terminal), and `/compact`, `/status` and `/goal` work in the chat (`/goal <objective>` sets a goal and works on it until a check says it is reached; `/goal` shows it, `/goal clear` ends it). You can attach images and files, open an earlier chat again (it is replayed), and the MCP servers your client lists (stdio) are started with the chat. See `docs/acp-design.md`.

## Config

`~/.sakura/config.toml` (set `SAKURA_HOME` to use another directory; sessions are stored in `sessions/` beside it). Precedence: defaults < file < profile < environment (`SAKURA_PROVIDER`, `SAKURA_MODEL`) < flags.

```toml
provider = "opencode"
permissions = "auto"
redaction = false
thinking = "medium"
max_tokens = 32000
# idle auto-compaction: after cache_ttl_minutes without activity, a context of at least
# auto_compact_min_tokens (never below 1000) is compacted; a profile may set these too
cache_ttl_minutes = 5
auto_compact_min_tokens = 20000
auto_compact_idle = true

[profiles.cheap]
provider = "deepseek"
thinking = "low"

[providers.lab]                    # any Chat Completions endpoint
base_url = "https://example.com/v1"
model = "some-model"
key_env = "LAB_API_KEY"
context_window = 128000
compat = "deepseek"                # a framework compat preset: deepseek, moonshot, openai
headers = { "x-team" = "a" }
session_header = "x-session-id"    # header that gets the session id, if the endpoint wants one

[mcp.servers.files]
command = "npx"
args = ["-y", "some-mcp-server"]
```

### Providers

| Name | Endpoint | Model | Key |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `deepseek-flash` | `DEEPSEEK_API_KEY` |
| `opencode` | `https://opencode.ai/zen/go/v1` | `deepseek-v4.1-flash` | `OPENCODE_API_KEY` |

Both use the framework's `compatPresets.deepseek`. OpenCode Go needs a session header on every request; the terminal sends `x-opencode-session: <session id>`. Without `-p`, the first provider whose key is set is used. Keys are read from the environment and never printed or stored.

## Frequently asked questions

**Which models does it work with?** Any endpoint that speaks Chat Completions (streaming and tool calls), set up under `[providers.NAME]` in `~/.sakura/config.toml`. It has been tried with DeepSeek and OpenCode Go, which are also built in.

**Where are my sessions stored, and how do I continue one?** In `~/.sakura/sessions/` (set `SAKURA_HOME` to use another directory), one append-only file per session. `sakuracode resume --last` continues the latest one; `sakuracode sessions` lists them; `/fork` copies one.

**What happens when the conversation gets too long?** It is summarised automatically when the context fills (and after a few idle minutes), or when you type `/compact`; the recent part stays word for word. `/status` shows how full the context is and how much of the input came from the provider's cache.

**Can I use it in scripts and CI?** Yes: `sakuracode exec "task"` runs one prompt without a screen, writes the reply to stdout and progress to stderr, and exits with 0 (done), 1 (error), 2 (usage error or paused by the review) or 130 (cancelled). `--json` gives the events as JSON lines.

**Can I keep it working toward a goal on its own?** Yes: `/goal "make the tests pass"` sets a goal and starts working; the agent is checked against it before it may stop.

**How is it different from Codex CLI?** Codex CLI is OpenAI's product with sandbox modes and approval policies. sakuracode is the reference terminal of the open-source Sakura framework: it uses automatic review instead of a sandbox and approval prompts, works with any Chat Completions endpoint, and is built only on the public SDK, so everything it does you can also do in your own agents with `sakura-agent`.

## Development

Run these commands from the repository root:

```bash
npm ci
npm --prefix code start
npm --prefix code test        # includes pseudo-terminal tests (needs python3)
npm --prefix code run typecheck
npm pack ./code               # build the release tarball (npm publish ./code publishes it)
```

The suite uses no network. To test a real provider, run `node --disable-warning=ExperimentalWarning code/test/live/interactive.ts PROVIDER WORKDIR [HOME]`.

Documents: [docs/design.md](docs/design.md) (modules and interfaces), [docs/test-report.md](docs/test-report.md) (what was run, including failures), [docs/framework-gaps.md](docs/framework-gaps.md) (what the framework lacks, with proposed changes).

## Not done

Clipboard image paste, wake-up of the agent by finished background commands, sub-agent definitions, a `--full-auto` style flag (use `--permissions full-access`), themes, and a TOML array-of-tables config. See `docs/framework-gaps.md` for why some of them wait on the framework.
