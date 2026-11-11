# sakuracode: design

`sakuracode` is a terminal application on top of the Sakura agent framework. It offers interactive sessions, slash commands, a status line, resume and fork, and steering, queueing, and cancellation during a run. It also supports non-interactive `exec` with a JSON event stream and a configuration file with profiles. It uses the public SDK through `src/framework.ts`. See [framework gaps](framework-gaps.md) for missing features.

## 1. Product defaults (from the owner)

| Default | Value | Where it is decided |
|---|---|---|
| Working directory | Never restricted. The agent starts in the directory where the command was launched and may go anywhere. No directory restriction is passed to the framework and no outside-directory rule is enabled. | `agent-session.ts` (passes `cwd` only, as the place where tools start) |
| Review plugin | ON by default. | `permissions.ts` |
| Redaction plugin | OFF by default; opt-in by config (`redaction = true`), flag (`--redact`) or `/redaction on`. | `permissions.ts` |
| Output | Markdown. Interactive: the assistant reply is rendered to the terminal. Non-interactive: the reply is written as Markdown text. | `markdown.ts`, `exec-mode.ts` |
| Providers | `deepseek` (`https://api.deepseek.com`, `deepseek-flash`, `DEEPSEEK_API_KEY`) and `opencode` (`https://opencode.ai/zen/go/v1`, `deepseek-v4.1-flash`, `OPENCODE_API_KEY`, per-session header `x-opencode-session`), both with `compatPresets.deepseek`. | `providers.ts` |

"Review ON" means the framework's `reviewPlugin` is installed: hard rules first, then the reviewer model, with a refusal going back to the agent as a tool error. It is not an approval prompt. Codex asks the human; the framework decides automatically (see section 5, permission presets).

## 2. Layering and modules

Dependencies point downward only. A module imports the modules below it, never above; the framework seam is the only place that touches `../sdk`.

```
cli.ts                      argument parsing, mode choice          (entry)
 ├─ tui/app.ts              interactive session: stdin, painting   (interactive shell)
 │   ├─ tui/keys.ts, tui/line-editor.ts, tui/live-region.ts, tui/transcript-view.ts, status-line.ts
 │   └─ session-controller.ts + slash-commands.ts                  (application core, no I/O)
 └─ exec-mode.ts            non-interactive run                     (batch shell)
      └─ session-controller.ts
session-controller.ts → agent-session.ts, session-store.ts, transcript.ts, config.ts, permissions.ts, providers.ts
transcript.ts → (nothing; pure)         markdown.ts → ansi.ts     status-line.ts → ansi.ts
agent-session.ts → framework.ts         providers.ts → framework.ts   permissions.ts → framework.ts
```

### Modules, what each owns, and its interface

| Module | Owns (one reason to change) | Interface (small) |
|---|---|---|
| `framework.ts` | The single import seam to `../sdk/index.ts`. If the framework moves, only this file changes. | re-exports of the SDK names the terminal uses |
| `toml.ts` | Parsing the TOML subset used by the config file (tables, dotted tables, strings, numbers, booleans, string arrays). | `parseToml(text): Record<string, unknown>` |
| `config.ts` | Config file shape, defaults, profiles, merging of file < profile < environment < flags. No I/O beyond reading the file. | `loadConfig({home, env}): FileConfig`, `resolveSettings(file, {profile, overrides}): Settings` |
| `providers.ts` | Which providers exist (built-in and user-defined), how to turn a provider choice into a `ModelConfig`, key lookup (never printing keys), the per-session header. | `listProviders(settings)`, `buildModelConfig(settings, providerName, sessionId, env): ModelConfig` |
| `permissions.ts` | Permission presets and the plugin list they produce: review policy lists, breaker, redaction opt-in. | `PERMISSION_PRESETS`, `buildPlugins({preset, redaction, reviewLlm}): Plugin[]` |
| `agent-session.ts` | Creating and closing a framework agent for a (provider, model, session file, settings) tuple; switching provider means close and recreate on the same file. | `openAgentSession(options): Promise<AgentSession>` where `AgentSession = { agent, provider, model, close() }` |
| `session-store.ts` | Where session files live, their sidecar metadata (id, cwd, title, model, timestamps), listing, finding by id/prefix/latest, naming a fork. | `createSessionStore(root)`: `create(meta)`, `list()`, `find(ref)`, `touch(id, patch)`, `forkPath(id)` |
| `transcript.ts` | Turning the framework's `Event` stream into a view-model of the conversation (blocks), including tool call summaries, real exit status of commands, review decisions, token usage. Pure reducer. | `createTranscript()`: `apply(event)`, `blocks()`, `onChange(listener)`; `loadBlocksFromLog(entries)` for resume |
| `markdown.ts` | Markdown to ANSI lines for a given width: headings, lists, quotes, fenced code, inline code, bold/italic/strike, tables, links, rules. | `renderMarkdown(text, {width, color}): string[]` |
| `ansi.ts` | Styles, stripping, display width (CJK and emoji are 2 columns), wrapping that keeps styles. | `style.*`, `stripAnsi`, `displayWidth`, `wrapAnsi(text, width)` |
| `status-line.ts` | The Codex-like status line: model, effort, directory, context left, run state. | `formatStatusLine(info, width): string` |
| `slash-commands.ts` | The command table (name, aliases, summary, argument parsing, handler), parsing a typed line, completion candidates. Handlers use only the `CommandHost` interface. | `parseSlash(line)`, `commandTable`, `complete(prefix)`, `CommandHost` |
| `session-controller.ts` | The application core: owns the current agent session, the run state (idle/working), routing a submitted line (prompt, slash command, steer/queue while working, `!` shell), cancel, `/compact`, `/model`, `/resume`, `/fork`, `/new`, `/goal`, `/init`, `/review`. No terminal I/O. Emits notifications to a `Surface`. | `createController(deps)`: `submit(text)`, `cancel()`, `state()`, `statusInfo()`, `close()`; it talks out through `Surface` |
| `exec-mode.ts` | Running one prompt (or stdin) to the end: Markdown to stdout, progress to stderr, `--json` event lines, exit codes, `--output-last-message`. | `runExec(options, deps): Promise<number>` |
| `tui/keys.ts` | Decoding raw stdin bytes into key events (arrows, Ctrl combos, Alt, bracketed paste, Shift-Enter variants). | `createKeyDecoder(): { push(chunk): KeyEvent[] }` |
| `tui/line-editor.ts` | The prompt text state: buffer, cursor, multi-line, history, word movement, kill/yank. Pure. | `createLineEditor()`: `handle(key)`, `value()`, `cursor()`, `set(text)`, history API |
| `tui/live-region.ts` | The bottom area of the screen that is redrawn (status, queued messages, composer, popup) while finished output scrolls above it in the normal scrollback. | `createLiveRegion(out)`: `print(lines)`, `setLive(lines, cursor)`, `clearLive()` |
| `tui/transcript-view.ts` | Blocks to terminal lines (user messages, rendered assistant Markdown, tool cards, reviews, errors, the banner); paths under the launch directory shown relative. Also used by `exec-mode.ts` for progress lines. | `renderBlock(block, {width, color, cwd}): string[]`, `toolHeadline`, `renderBanner` |
| `tui/screen.ts` | The live area for a state (progress, prompt, status line, popup, picker). Pure. | `composeLive(state): {lines, cursor}` |
| `run-driver.ts` | One run at a time: events to the transcript, steer/queue bookkeeping (delivery found in the log, see gap T2). | `createRunDriver(transcript)` |
| `reports.ts`, `shell.ts`, `mentions.ts`, `framework-testing.ts` | `/status` etc. text; user shell commands; `@path`; the framework's scripted model (`sakura-agent/testing`) for tests and for `SAKURACODE_FAUX_SCRIPT` / `SAKURACODE_FAUX_REVIEWER`. | small pure functions |
| `tui/app.ts` | Wiring stdin/stdout to the controller and views, Ctrl-C/Esc behaviour, popups for slash completion and the resume picker. | `runTui(options): Promise<number>` |
| `cli.ts` | `node:util.parseArgs`, help text, choosing TUI or exec, sub-commands `exec`, `resume`, `fork`, `login`-free. | `main(argv, io): Promise<number>` |

### The two seams that keep the core testable

* `Surface` (controller to the outside): `blocks changed`, `status changed`, `notice(text)`, `ask-pick(items)`. The TUI implements it with painting; the exec mode implements it with stdout/stderr; tests implement it with arrays.
* `AgentSession` factory (controller to the framework): tests inject a factory that builds an agent from a scripted model, so the controller, slash commands and exec mode run end to end without a network.

## 3. Interaction model

* **Inline, not full screen.** Like Codex, the terminal's own scrollback is kept: finished blocks are printed above; the bottom region (a working indicator, queued messages, the composer box, the status line) is redrawn in place. No alternate screen.
* **Pinned composer.** The live area always ends on the last row of the window: while little has been printed, blank rows are left between the output and the live area and printed lines fill them (`createLiveRegion(out, { pinned: true })`). Only newlines and cursor moves are used, no scroll region, so nothing changes for the terminal's scrollback in any terminal. After a resize the padding is dropped and the live area follows the output.
* **Folding long input.** A paste of more than 1000 characters or more than 5 lines becomes a placeholder `[Pasted Content N chars]` (Codex's wording; `#2`, `#3` for equal sizes). The editor keeps the text; `value()` is what is shown, `expanded()` what is sent. The placeholder is one unit for Backspace, Delete and the arrows. The transcript shows the sent text, cut to ten rows with `… +N lines`. Up-arrow recall restores the placeholder and the real text with it. A typed message taller than the composer limit (a third of the window, at most 8 rows) shows the rows around the cursor between `… +N lines` markers.
* **Idle compaction.** `idle-compaction.ts` waits `cache_ttl_minutes` after the last key or run event; then, if no run is going and the composer is empty (otherwise it retries every 30 s), the controller compacts when the context holds at least `auto_compact_min_tokens` and says so in one dim line.
* **Streaming.** Assistant text is committed block by block (paragraphs, lists, a closed code fence) rendered as Markdown as soon as a block is complete; the unfinished tail is shown dimmed in the live region. At message end the rest is flushed. Reasoning deltas are shown as a one-line dim "thinking" indicator, not stored in the transcript.
* **While the agent works.** `Enter` = steer (delivered before the next model request); `Tab` = queue (handled when the agent would stop); `Esc` or `Ctrl-C` = cancel the run; a second `Ctrl-C` when idle (or `/exit`) leaves. Messages typed during a run are shown above the composer as "steering"/"queued".
* **Slash commands** are typed at the start of the line; a popup lists matches (Tab completes).
* **Keys in the composer:** `Enter` send, `Shift-Enter` / `Alt-Enter` / `Ctrl-J` newline, `↑/↓` history (or line movement in multi-line text), `Ctrl-A/E/K/U/W`, word movement, bracketed paste.

## 4. Feature list mapped to Codex

The mapping was checked against the Codex documentation; what could not be verified is marked in `codex-parity.md` and `test-report.md`.

| Codex feature | sakuracode | Module | Status target |
|---|---|---|---|
| Interactive TUI session | inline TUI | `tui/*` | done |
| Status line (model, effort, directory, context left) | `status-line.ts` using `agent.context()` | `status-line.ts` | done |
| `/status` | session id, provider, model, directory, permissions, redaction, context, token usage | `slash-commands.ts` | done |
| `/model` | pick provider and model; closes and recreates the agent on the same session file | `session-controller.ts` | done |
| `/permissions` (approvals and sandbox) | presets over the review plugin (no human prompt, no sandbox, by design) | `permissions.ts` | done (differs from Codex, documented) |
| `/review` | asks the agent to review `git diff` (uncommitted changes, or against a base) | `session-controller.ts` | done |
| `/init` | asks the agent to write `AGENTS.md` | `session-controller.ts` | done |
| `/mcp` | lists MCP servers from `agent.mcp`; servers come from config `[mcp.servers.*]` | `session-controller.ts` | done |
| `/goal` | `agent.setGoal/goal/clearGoal` | `session-controller.ts` | done |
| `/compact` | `agent.run(undefined, {compact: true})` | `session-controller.ts` | done |
| `/new`, `/clear` | new session file (clear also clears the screen) | `session-controller.ts` | done |
| `/resume`, `resume` sub-command, `--last` | session store listing, picker | `session-store.ts`, `tui/app.ts` | done |
| `/fork` | `agent.fork` into a new session file and switch to it | `session-controller.ts` | done |
| `/undo` (retry from an earlier message) | `agent.rewindTo` the entry before the last user message | `session-controller.ts` | done |
| `/diff` | prints `git diff` | `slash-commands.ts` | done |
| `/exit`, `/quit` | leave | `slash-commands.ts` | done |
| Steer, queue, cancel mid-run | `agent.steer/queue/cancel` | `session-controller.ts` | done |
| Non-interactive `exec`, `--json` | `exec-mode.ts` | `exec-mode.ts` | done |
| Config file with profiles | `~/.sakura/config.toml`, `[profiles.NAME]`, `--profile` | `config.ts` | done |
| `!command` run a shell command yourself | runs in the working directory, output shown | `session-controller.ts` | done |
| `@file` mention | `@path` tokens are resolved and the file is named to the agent | `mentions.ts` | done |
| Image input | not offered: the framework's `UserInput` takes image content by `ref`, but no verified path from a terminal file to a ref exists (checked in `framework-gaps.md`) | — | not done |
| Redaction toggle | `--redact`, config, `/redaction` | `permissions.ts` | done (extra) |

## 5. Permission presets

| Preset | Review plugin | Meaning |
|---|---|---|
| `auto` (default) | on, default policy | hard rules and a reviewer model judge each call; refusals go back to the agent |
| `read-only` | on, policy with write/exec actions soft-denied and the tool set reduced to `read` | the agent can look but not change |
| `strict` | on, circuit breaker (`consecutive: 3`) so repeated refusals pause the run | for unattended use |
| `full-access` | off | nothing is reviewed (explicit opt-out) |

None of the presets restricts the working directory; the review plugin is created with `directoryRules: false`.

## 6. Config

`~/.sakura/config.toml` (`SAKURA_HOME` overrides the directory):

```toml
provider = "opencode"          # default provider
permissions = "auto"
redaction = false
[profiles.fast]
provider = "deepseek"
model = "deepseek-flash"
thinking = "low"
[providers.mylab]               # user-defined, OpenAI-compatible chat completions
base_url = "https://example.com/v1"
model = "some-model"
key_env = "MYLAB_API_KEY"
context_window = 128000
compat = "deepseek"             # name of a framework compat preset, optional
[mcp.servers.files]
command = "npx"
args = ["-y", "some-mcp-server"]
```

Precedence: built-in defaults < config file < selected profile < environment (`SAKURA_PROVIDER`, `SAKURA_MODEL`) < command-line flags.

## 7. Testing plan

1. Unit tests per module, no model and no terminal (`node --test`): toml, config, providers, permissions, ansi, markdown, transcript, line-editor, keys, slash-commands, status-line, session-store, live-region (against a recording stream).
2. Integration with a scripted model: controller + exec mode + agent-session with a hand-written scripted `LlmClient` (the same idea as the framework's faux client, kept inside `code/test/support` so the tests do not reach into framework internals).
3. A pseudo-terminal test of the real binary (Python `pty`, driven from a Node test) with a scripted model selected by an environment hook that exists only for tests (`SAKURACODE_FAUX_SCRIPT`).
4. Live runs against DeepSeek and OpenCode Go, recorded honestly in `test-report.md`.
