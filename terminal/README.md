# Sakura Terminal

A terminal coding agent in the style of OpenAI Codex CLI, built on the Sakura agent framework. It lives entirely in this directory: it has its own `package.json`, tests and docs, and it reaches the framework only through `../sdk/index.ts` (see `src/framework.ts`).

* Interactive inline session: your terminal's scrollback is kept, the prompt and the status line stay at the bottom.
* Replies are rendered as **Markdown** (headings, lists, tables, fenced code, inline code, links). `exec` writes Markdown too.
* Slash commands, `!shell`, `@file` mentions, resume, fork, undo, `/compact`, goals, MCP servers.
* Steer, queue or cancel while the agent works.
* `exec` mode with a `--json` event stream; config file with profiles.
* Two providers built in: DeepSeek and OpenCode Go.

## Defaults

| | |
|---|---|
| Working directory | The agent starts in the directory where you launched the command and **may go anywhere**. Nothing is restricted to the directory and no outside-directory rule is enabled. (`-C DIR` only changes where it starts.) |
| Review | **On.** Every tool call goes through the framework's review plugin: hard rules first, then a reviewer model. A refused call goes back to the agent as a tool error. There is no approval prompt: the review decides on its own. |
| Redaction | **Off.** Turn it on with `--redact`, `redaction = true` in the config, or `/redaction on`. |
| Output | Markdown. |

## Install and run

Needs Node 24 or newer (the sources are TypeScript and run directly) and the repository's `node_modules` (the framework is imported by relative path, so run `npm install` once in the repository root).

```bash
cd terminal
export DEEPSEEK_API_KEY=...        # and/or OPENCODE_API_KEY=...
node --disable-warning=ExperimentalWarning bin/sakura-terminal.mjs
```

For a shorter command, link it: `npm link` inside `terminal/`, then `sakura-terminal`.

```bash
sakura-terminal                          # interactive session
sakura-terminal "fix the failing test"   # interactive, the prompt is sent at once
sakura-terminal --provider opencode      # choose the provider
sakura-terminal -i error.png "what does this error mean?"   # attach an image
sakura-terminal resume --last            # continue the latest session (a picker without --last)
sakura-terminal fork --last              # copy the latest session into a new one
sakura-terminal review --base main       # review the changes against main, print the review
sakura-terminal exec "summarise this repo"            # one run, Markdown on stdout
sakura-terminal exec --json "list the TODOs" | jq .   # events as JSON lines
echo "explain this error" | sakura-terminal exec -    # prompt from stdin
sakura-terminal sessions                 # list sessions
sakura-terminal providers                # providers and whether their key is set (never the key)
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
| `-q, --quiet` | `exec`: no progress lines on stderr |
| `--output-last-message FILE` | `exec`: also write the final reply to FILE |
| `--no-color` | no colours |

`exec` exit codes: 0 done, 1 error, 2 usage error or paused by the review breaker, 130 cancelled. In `exec`, progress goes to stderr (one line per tool call) and the final reply goes to stdout; on a terminal it is rendered, in a pipe it is the raw Markdown.

## In the session

| Key | While idle | While the agent works |
|---|---|---|
| Enter | send | **steer**: delivered before the agent's next model request |
| Tab | complete a slash command | **queue**: handled when the agent would stop |
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
| `/status` | session, directory, model, permissions, context and token usage |
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
| `/goal [objective\|clear]` | show, set or clear the goal of the session |
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

None of them restricts the working directory. The reviewer model is told that the whole machine is the agent's workplace and that system locations, credentials, publishing, force-pushes and sending secrets out stay forbidden (`src/permissions.ts`).

## Config

`~/.sakura/config.toml` (set `SAKURA_HOME` to use another directory; sessions are stored in `sessions/` beside it). Precedence: defaults < file < profile < environment (`SAKURA_PROVIDER`, `SAKURA_MODEL`) < flags.

```toml
provider = "opencode"
permissions = "auto"
redaction = false
thinking = "medium"
max_tokens = 32000

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

## Development

```bash
npm test            # offline suite: unit, controller, in-process TUI, real binary, pseudo-terminal (needs python3)
npm run typecheck   # TypeScript, strict
```

The suite uses no network. A live check against a real provider: `node --disable-warning=ExperimentalWarning test/live/interactive.ts PROVIDER WORKDIR [HOME]` (a few model calls).

Documents: [docs/design.md](docs/design.md) (modules and interfaces), [docs/test-report.md](docs/test-report.md) (what was run, including failures), [docs/framework-gaps.md](docs/framework-gaps.md) (what the framework lacks, with proposed changes).

## Not done

Clipboard image paste, wake-up of the agent by finished background commands, sub-agent definitions, a `--full-auto` style flag (use `--permissions full-access`), themes, and a TOML array-of-tables config. See `docs/framework-gaps.md` for why some of them wait on the framework.
