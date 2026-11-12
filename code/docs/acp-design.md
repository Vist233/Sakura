# sakuracode as an ACP agent: design and decisions

Status: A0, A1, B1, B2 and B3 are built. Client file and terminal access and the registry are not planned yet. The original plan, with sources and test levels, is `docs/46-acp-plan.md` in the framework repository (local record). This file keeps what is decided or built.

## Record of the build

| Phase | What was built | Checks at the end |
|---|---|---|
| A0 | SDK `@agentclientprotocol/sdk` 2.4.0 pinned (2.6.0 was one day old; the owner's rule is seven), `zod` 4.6.7, schema fixture and pin test, this document | `code/` 275 tests |
| A1 | `sakuracode acp`: `initialize`, `authenticate`, `session/new`, `session/prompt` with streamed message and thought chunks, stop reasons, `session/cancel`, `$/cancel_request`, one prompt at a time per session, review mode `auto`, stdout purity; README sections for T3 Code | 340 tests; official TCK CONFORMANT (31 of 31 required checks) |
| B1 | model and thinking selectors, `session/set_config_option`, agent rebuilt on the same session file, deferred change during a turn, `config_option_update`; T3 Code section with absolute paths | 357 tests |
| B2 | tool cards with kinds, diffs and locations, `usage_update`, `available_commands_update`, `/compact` and `/status`, snapshot plugin | 386 tests; TCK CONFORMANT |
| B3 | `session/load` with replay, image and embedded-resource prompt blocks, stdio MCP servers from `session/new` and `session/load` | 407 tests; TCK CONFORMANT with no failure at all (54 passed, 20 skipped for capabilities not advertised) |

Coverage of `src/acp/` at the end of B3: 99.71 % of lines, 96.02 % of branches, 95.00 % of functions. Files outside `src/acp/` touched by this work: `src/cli.ts` and `src/invocation.ts` (the `acp` subcommand), `src/agent-session.ts` (the optional `extraPlugins` field), `package.json` and `package-lock.json` (the two dependencies), the two READMEs, and the root `THIRD_PARTY_NOTICES.md`. Nothing in `packages/` was changed.

## Decisions

| Topic | Decision | Reason |
|---|---|---|
| Door | `sakuracode acp` (a subcommand of the existing package) | T3 Code adds an agent as a local command: executable `sakuracode`, one literal argument `acp`. The same shape fits an `npx` registry entry later. |
| SDK | `@agentclientprotocol/sdk` **2.4.0**, exact pin, default (stable v1) entry point, plus `zod` 4.6.7 (a required peer dependency of the SDK) | 2.4.0 (2026-11-02) is the newest release that meets the owner's 7-day minimum release age; 2.6.0 differs only by `systemPrompt` on new/load requests, which is not used. The SDK validates every message against the schema. Everything planned is in the stable v1 schema (`usage_update`, `compaction_update`, config options, `available_commands_update`, `session/load`, `session/set_mode`, `session/set_config_option`), so no `/unstable` import is needed. |
| Protocol version | **ACP v1** (`PROTOCOL_VERSION` is 1). The v2 draft (`/experimental/v2`) is not used. | T3 Code prefers a v2 preview and falls back to v1; the SDK says v2 can change incompatibly in any release. `initialize` answers 1 whatever the client asks. |
| Where the SDK is imported | `src/acp/connection.ts` only (a test enforces it) | Every mapper stays pure and SDK-free (`types.ts` holds plain wire types), so an SDK change touches one file. |
| API shape | The SDK's "app" API: `agent().onRequest(methods.agent.…, handler).connect(ndJsonStream(output, input))`; the in-process test client is `client().onNotification(…).connect(stream)` | SDK 2.x removed `AgentSideConnection` and `ClientSideConnection`. |
| Permissions | New sessions use review mode `auto`. `--permissions strict\|read-only` after `acp` changes it; `full-access` runs only when asked for on that command line, never from the config file alone. `session/request_permission` is never called: Sakura reviews every call itself. | The owner's rule: no `full-access` by default. |
| Credentials | Keys come from the environment of the agent process or `~/.sakura/config.toml`, as in the terminal application. With no key, `session/new` fails with the `auth_required` code (-32000) and names the variable to set. `authMethods` is empty and `authenticate` is a no-op that succeeds. | T3 Code passes environment overrides; there is no login flow yet (phase A5). |
| Stdout | Protocol lines only. Logs are JSON lines on stderr (`SAKURACODE_ACP_LOG=off\|error\|warn\|info\|debug`, default `warn`); `console.*` is redirected to stderr in the real process. | Anything else on stdout would corrupt the stream. |

## Modules (`src/acp/`)

| Module | Job | Pure |
|---|---|---|
| `connection.ts` | JSON-RPC link over a pair of byte streams; the only SDK import; turns `AcpError` into JSON-RPC errors and gives the agent a `ClientChannel` for updates | no |
| `agent.ts` | the ACP methods: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`; every handler wrapped once so a failure becomes a coded error, never a crash | no |
| `sessions.ts` | many framework sessions in one process; one turn at a time per session (a second prompt gets the busy error -32001); cancel; close all. Session files live in the same store as the terminal's, titled from the first prompt, so `sakuracode sessions` lists them | no |
| `events-to-updates.ts` | framework events to `agent_message_chunk` and `agent_thought_chunk` with message ids; a reply that is sent again after a dropped connection gets a new id (ACP cannot take chunks back) | yes |
| `content.ts` | prompt blocks to text: text blocks, `file:` links as `@path` mentions, other links as Markdown, a one-line note for blocks not read yet (images, audio, embedded resources) | yes |
| `stop-reasons.ts` | run result to stop reason: done is `end_turn`; a requested cancel is always `cancelled` (also when the abort surfaces as an error); a pause is `refusal` plus a note; a failed run is a -32603 error whose text has credentials removed | yes |
| `config-options.ts` | the selectors: `model` (category `model`; one entry per configured provider, value = the provider name, label = its model, so `deepseek/deepseek-v4-flash` or a 1M-window model is just a label) and `reasoning_effort` (category `thought_level`, so clients that match on the category or on the id both find it; off/low/medium/high, only for providers whose compat preset has a thinking format); a client change to the next choice, with the right error (-32602 unknown option or value, -32000 provider without key) | yes |
| `tool-mapping.ts` | a tool call as a card: kind (`read`, `edit` for write and edit, `execute` for bash, `fetch`/`search` by name, else `other`), title, absolute locations with 1-based lines, a diff per edit and for a write, the command and its output for bash, status `completed` or `failed`; long text is cut with a note that says how much; arguments are copied with long strings cut | yes |
| `commands.ts` | the slash commands offered in the client's menu and handled inside a prompt: `/compact`, `/status`, `/goal`, `/undo`, `/fork`, `/mcp`, and `/review [focus]` and `/init`, which become the terminal's own prompts (`reviewPrompt`, `INIT_PROMPT` from `src/slash-commands.ts`); any other slash text is an ordinary prompt | yes (imports the two prompt texts) |
| `goal-notes.ts` | the goal checks the framework leaves in the session log, as short notes for the person | yes |
| `snapshot-plugin.ts` | a framework plugin (`tool.before`) that notes what a file holds before `write` replaces it, so the diff starts from the old text; the events reach the client asynchronously and could be too late | no |
| `replay.ts` | a session log as updates for `session/load`: user text as `user_message_chunk`, assistant text and tool cards through the same mapper as a live run, so a loaded conversation looks like the streamed one; message ids are the log entry ids | yes |
| `mcp.ts` | the MCP servers a client lists, as the framework's definitions (stdio only; names made safe for tool names and unique; `env` as a record); the others are counted and left out | yes |
| `attachments.ts` | writes the images of a prompt to files next to the session (`<store>/<session id>.images/<hash>.<ext>`), because the framework reads images by path | no |
| `capabilities.ts` | our `initialize` answer: version 1, `loadSession`, images and embedded context, no audio, no HTTP or SSE MCP | yes |
| `auth.ts` | chooses the provider and turns a missing key into `auth_required` (reads whether a variable is set, never its value) | no |
| `log.ts` | JSON-line logger | yes |
| `serve.ts` | wires the parts; `runAcp` for tests, `serveProcess` for the process (stdin/stdout as web streams, console to stderr, SIGINT/SIGTERM end the run, a second signal exits at once) | no |

Rules enforced by `test/acp/boundaries.test.ts`: only `connection.ts` imports the SDK; `acp/*` reaches the framework only through `framework.ts` and never imports `tui/`; only `cli.ts` imports `acp/` from outside; the pure mappers import only `types.ts`, `framework.ts` (types) and `node:crypto`.

## Model and thinking selectors (B1)

* `session/new` returns `configOptions`; `session/set_config_option` changes one. A change rebuilds the framework agent on the same session file (the history stays), like `/model` in the terminal; the answer carries the full option list and `config_option_update` follows. Setting the value it already has does nothing.
* During a running turn the agent is not rebuilt: the change is remembered (the last one wins), the answer already shows the wanted value, and the switch happens when the turn ends, before the prompt response (so no update follows the response). If it fails, the old setup stays and the options are sent again.
* A provider whose key is not set is listed with the variable to set; choosing it answers `auth_required`. A thinking level is kept across a model change where the new model has one.
* The review mode is a third selector, see "Review mode" below.
* The thinking selector has the id `reasoning_effort` and the category `thought_level`: a client that matches on the category (Zed) and one that matches on the id (T3 Code, not confirmed from its source) both find it. Levels are the kernel's `ThinkingLevel` (off, low, medium, high), the same as `--thinking`; each has a description.
* The chosen level is saved in the session metadata (`thinking`), so `session/load` and `/fork` keep it (before, they fell back to the configured default). The review mode is not saved: a loaded session gets the mode the agent was started with, so `full-access` is never restored.
* Model option labels are `model (provider)` because two providers may serve the same model; the description says which key to set when one is missing. Mode names are capitalised (`Auto`, `Read-only`, `Strict`); the ids stay.

## Tool cards, meter and commands (B2)

* `tool_start` becomes a `tool_call` (status `in_progress`), `tool_end` a `tool_call_update` (`completed` or `failed`, with the output and the raw output). A review refusal is a failed call whose text is the refusal. An edit shows one diff per replacement. A write shows its diff when the call ends, because only then is the old text known for certain; an in-progress write card has no diff yet.
* `usage_update` (used and window tokens) follows every reply that reports usage, every compaction (an estimate until the next reply) and every model change (the window may differ).
* `available_commands_update` is sent right after the `session/new` answer. `/compact` runs a compaction (a short note says how large the context was); `/status` answers with the same table as the terminal and starts no run.
* The compaction is shown as a short text note. The client capability `session.compaction` (ID-addressed compaction updates) is not used yet.
* `src/agent-session.ts` got one optional field, `extraPlugins`, which the ACP sessions use for the snapshot plugin; the terminal does not pass it.

## Loading, images and MCP (B3)

* **`session/load`** (advertised as `loadSession: true`) opens a session from the store on its session file, with the provider it used if that can be used now, and replays the log before it answers: the user's messages, the replies, the tool cards (without in-progress states). The reasoning is not in the log, so it is not replayed. A `usage_update` and the command menu follow. An unknown id is -32002; a relative cwd is -32602. Loading a session that is already open replays it again and changes nothing else. Sessions made by the terminal can be loaded too, since both use the same store.
* **Images and resources in prompts:** `promptCapabilities` is now `image: true`, `embeddedContext: true`, `audio: false`. An image is written to a file next to the session (the same picture twice is one file) and sent to the model as an image part; at most 10 images of about 10 MB each. An embedded text resource is quoted with its address (cut at 100,000 characters); binary resources, audio and unknown blocks leave a one-line note. A prompt with only an image runs. Whether the chosen model reads images is the provider's business (the built-in providers do).
* **MCP servers from the client:** stdio servers in `session/new` and `session/load` are started with the session, next to those in `config.toml`, and their tools are named `mcp__<server>__<tool>` as usual. They are kept across a model change. `env` values (and `headers`) are credentials: they are passed to the server process and never logged, echoed or stored. HTTP and SSE servers are not advertised (`mcpCapabilities` stays false); one that arrives anyway is left out with a warning that gives the count only.

## The goal command

Mirrors the terminal. `/goal` alone shows the goal (`Goal (active|blocked|complete): …`, or that none is set); `/goal clear` or `/goal off` ends it; `/goal <objective>` sets it (replacing an earlier one), says so, and works on it with the objective as the prompt, as in the terminal. The framework then checks the work against the goal before the agent may stop. Progress reaches the client as ordinary message chunks: after each check that finds items left, "Goal check: … Remaining items: …" (read from the `goal_check` entries the framework writes to the log, because it sends no event for them; they are looked up when the next turn starts), and "Goal reached" or "Goal blocked" when the framework says so. Setting or clearing a goal during a running turn answers busy (-32001), because the framework refuses it then. The menu entry carries the input hint "objective, or clear".

## Review mode (C1)

* `session/new` and `session/load` offer the mode as a config option with category `mode` (values `auto`, `read-only`, `strict`, with the summaries of `src/permissions.ts`) and, for clients that only know the older call, as `modes`. `session/set_config_option` and `session/set_mode` both change it. The change rebuilds the agent on the same session file like a model change (the history stays), is deferred to the end of a running turn, and is announced with `config_option_update` and, when the mode changed, `current_mode_update`.
* **`full-access` is opt-in, and the client cannot opt in for the person.** It appears among the choices only when `sakuracode acp` was started with `--permissions full-access` or `--yolo` on the command line; a config file that says `full-access` does not count (the session starts in `auto`, as before). Asking for it otherwise is an invalid-params error that says how to get it. The reason: with full-access nothing is reviewed, so the choice belongs to the person who starts the agent (in T3 Code: the arguments of the command), not to a button the client or a prompt injection could press. Starting with it makes it the starting mode and lets the client switch back and forth.
* A model change keeps the mode and the thinking level where they still apply.

## More commands (C2)

* `/undo` goes back to before the last user message (the model forgets it) and shows that message again in the chat, because ACP has no way to put text into the client's input box; the client can paste it back. `/fork` copies the conversation into a new stored session and says its id. **The limit:** a chat command cannot switch the client to another session, so the original chat stays as it is, and the copy is opened with `session/load` where the client offers it, or in the terminal with `sakuracode resume <id>`. `/mcp` shows the same table as the terminal. `/review [focus]` and `/init` run the terminal's prompts as an ordinary turn. All of them but `/mcp` answer busy while a turn runs.
* **Not added:** `/redaction`. Redaction is a startup choice (`--redact`, or `redaction = true` in the config) that changes what leaves the machine; a switch for the client would be a fourth thing that rebuilds the agent, for a setting that is rarely flipped mid-chat. `/help`, `/new`, `/clear`, `/resume`, `/rename`, `/exit` and `/diff` belong to the client, as agreed.
* `src/slash-commands.ts` got one change: `INIT_PROMPT` is exported.
* The logic of undo and fork is now written a second time, in `sessions.ts` (the terminal has it in `session-controller.ts`); see the review of duplication below.

## `@` references and idle compaction (C3)

* **`@path` references.** Before this check the agent turned a file link from the client into the text `@/abs/path` and stopped there: unlike the terminal it never ran `expandMentions`, so the model was not told to look at the file, a typed `@notes.md` was left as it was, and a link to a picture did not attach the picture. Fixed with a call to the existing `expandMentions` (no new module): the paths that exist are named to the agent exactly as in the terminal, relative ones against the session's directory, and picture files are attached. A path that does not exist is left alone. Three L2 tests cover it.
* **Idle compaction (added after this check).** It did not exist in ACP: the terminal starts it from its own screen. Now `idle.ts` does it, see "Idle compaction" below.

## Idle compaction

* **Where it is written.** The timing is the terminal's own `createIdleCompaction` (`src/idle-compaction.ts`, shared and unchanged). `src/acp/idle.ts` wires it to ACP sessions: one timer per session, started when the session is opened and again each time a turn ends (`agent.ts` calls `touch`), cancelled when the process stops. The compaction itself is `compactIdle` in `sessions.ts`. `serve.ts` builds the pieces.
* **Settings are the terminal's, unchanged:** `auto_compact_idle` (default on), `cache_ttl_minutes` (default 5, the wait), `auto_compact_min_tokens` (default 20,000; never below 1,000, the terminal's floor, which is repeated as a constant in `sessions.ts` because it is private in `session-controller.ts`).
* **What happens.** When the wait is over and no turn runs, and the context holds at least the minimum, the agent runs the same compaction as `/compact`. Afterwards the client gets one `usage_update` (its meter is out of date) and the log gets one line (`compacted after idle`, with the sizes). No message is written to the chat. If a turn is running at the moment, the timer tries again after 30 seconds.
* **A prompt that arrives during the compaction** waits for it to end and then runs, as if it had been steered in; it is not refused. A change of model or mode asked for then is applied as usual (the compaction counts as a running turn, so it waits for the end).
* **If the process is killed while it compacts,** the session file is as it was: the framework writes the compaction entry only after the summary is complete.
* The process lives as long as the client keeps it (the client starts it once and keeps stdin open); if a client stops the process when a chat closes, nothing happens, and nothing is lost.

## Pinned dependency and fixtures

* `code/package.json` lists `@agentclientprotocol/sdk` as `2.4.0` and `zod` as `4.6.7`, both exact. `code/package-lock.json` records the hashes (all addresses are on the public registry).
* The published package does not bundle them: `npm pack` stays small and the user's install adds the two packages (the SDK is several MB unpacked, mostly type declarations and the v2 draft).
* `test/acp/fixtures/protocol-v1.json` is a compact record of the stable v1 schema taken from the installed SDK (version, a hash of `schema.json`, all method names, the fields of the shapes the agent builds or reads, the values of the unions it switches on). `test/acp/sdk-pin.test.ts` compares it with the installed schema. A change of the wire format fails the test; recording a new one is deliberate: `UPDATE_ACP_FIXTURES=1 npm test`.

## Tests

* **L1 (pure):** `events-to-updates.test.ts` (table and a seeded property test), `pure-modules.test.ts` (content, stop reasons, capabilities, log), `sessions.test.ts` (provider choice, titles, a failing sink, close).
* **L2 (in process):** `agent.protocol.test.ts` runs our agent against the SDK's own client over in-memory streams: initialize, authenticate, streaming, reasoning, resent replies, cancel, the busy error, several sessions, error answers (no credential in them), non-text blocks, unknown method, missing key.
* **L3 (real process):** `process.test.ts` spawns `bin/sakuracode.mjs acp` with the faux model hooks and fails on any stdout line that is not JSON-RPC; also stdin close, SIGTERM during a turn, garbage input, and the startup time. `serve-process.test.ts` checks that `console.*` goes to stderr.

## Conformance tool (run at the end of A1)

`agentclientprotocol/acp-tck` (Python 3.14 with `uv`; experimental; its result is not an official certificate) starts an agent as a stdio subprocess and reports which protocol requirements pass, fail, do not apply or were not exercised. It was fetched with the owner's approval into a scratch directory outside the repository, at commit **`b7f40fb3c003c45926547be5a1f7e2b374035815`** (2026-10-23, tck 0.2.0, schema revision `beac4ba96190018e9f6d82e148ff275084c5aa3e`), and is **not** a dependency of this repository. It was run in an isolated `uv` environment (cache, Python and virtualenv inside the scratch directory) with a scrubbed environment, against the real `sakuracode acp` on the faux provider hooks (no key, no provider traffic).

Two runs are needed because the faux model answers by script: one run with a script of plain replies for everything but cancellation, one with a script whose turns never finish for the cancellation requirements (`-k cancel`).

Result (protocol v1):

| Tier | Pass | Fail | Skipped (not applicable) |
|---|---|---|---|
| Mandatory (31) | 31 | 0 | 0 (the 3 skipped in run 1 are the cancellation ones, which pass in run 2) |
| Capability (23) | 0 | 0 | 23: image, audio, embedded context, `loadSession`, `resume`, `list`, `delete`, `close`, `additionalDirectories`, `systemPrompt`, logout, modes/config options are not advertised |
| Advisory (13) | 10 | 1 | 2 |
| Informational (5) | 5 | 0 | 0 |

Verdict of the full run at the end of A1: **CONFORMANT**; the one advisory failure then was `ACP-SESSION-004` (connect to the MCP servers the client lists). After B3 the same two runs give no failure at all: mandatory 29 passed plus the 2 cancellation checks in the second run, capability 6 passed (session load, config options, embedded context), advisory 12 passed, informational 5 passed; 17 capability checks are skipped because the capability is not advertised (audio, `resume`, `list`, `delete`, `close`, `additionalDirectories`, `systemPrompt`, logout).

The TCK found one thing worth fixing, which is done: it exercised `$/cancel_request` (an optional cancel of one request). The agent now ends the turn when the prompt request is cancelled, like `session/cancel` (`ACP-JSONRPC-007` went from skipped to pass; covered by an L2 test).

To repeat: clone the repository at that commit into an empty directory, then run `uv run acp-tck --agent-cwd <empty dir> --agent-env SAKURA_HOME=<empty dir> --agent-env SAKURACODE_FAUX_SCRIPT=<script.json> -- node bin/sakuracode.mjs acp` with `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR` and `UV_PROJECT_ENVIRONMENT` pointing into that directory and a minimal environment (`env -i`), because the TCK passes its whole environment on to the agent.

## Not built yet

Plan updates from a goal, compaction updates addressed by id (the client capability `session.compaction`), audio, HTTP and SSE MCP servers, `session/list`, `session/set_mode` and a review-mode selector, client file and terminal access (phase A4), the registry entry and `sakuracode setup` (A5). A client cannot override a refused call (Sakura has no human approval step by design).

## Review: cohesion and a lean architecture (2026-11-11)

The owner's direction: separate the **core** from its **components** so each part can change on its own, keep the architecture lean, and do not add a module or a layer for its own sake: what works stays as it is. Nothing below has been changed; the lead decides.

**Core** (the parts every request goes through): `connection.ts` (the SDK, one file), `serve.ts` (process lifecycle), `agent.ts` (routes protocol methods), `sessions.ts` (session lifecycle, one turn at a time, cancel), `events-to-updates.ts` (the event to update pipeline). **Components** (each one a single feature, pure where it can be): `config-options.ts` (model, thinking, review mode), `commands.ts`, `tool-mapping.ts`, `content.ts` and `attachments.ts` (prompt blocks, images), `mcp.ts`, `replay.ts`, `goal-notes.ts`, `stop-reasons.ts`, `capabilities.ts`, `auth.ts`, `snapshot-plugin.ts`, `log.ts`, `types.ts`. The dependency rule already holds: components import only `types.ts`, the framework seam and each other in one direction (`replay` and `events-to-updates` use `tool-mapping`); the core imports components, never the reverse (checked by `test/acp/boundaries.test.ts` for the pure ones).

**Where responsibilities are mixed**

| Place | What is mixed | Size now |
|---|---|---|
| `sessions.ts` | Four jobs in one file: the registry and turn control (create, load, run, cancel, close), reconfiguration (provider choices, the view with a pending change, review modes, rebuild), thin wrappers over the framework agent for commands (goal, undo, fork, mcp, status, measure, history), and image saving. | 386 lines, the largest |
| `agent.ts`, the `prompt` handler | Command dispatch (`/status`, `/goal`, `/undo`, `/fork`, `/mcp`), building the input (mentions, images), wiring the event pipeline (goal notes, compaction note, meter) and applying a pending change, all in one function. | about 100 lines |

**What only passes things through**
* `capabilities.ts` once held `readClientFeatures` and `features()` (what the client advertised) which nobody read; **removed on 2026-11-11** (see the decisions below). Phase A4, client file and terminal access, adds it back when it has a user.
* `auth.ts` (27 lines, one function, one user: `sessions.ts`) and `attachments.ts` (26 lines, one function, one user): small, but separate files for one call each.
* The goal, undo, fork and mcp methods of `sessions.ts` are one to ten lines around a framework call, with the busy check. They exist so `agent.ts` never touches the framework agent.

**Duplication with the terminal code**

| Terminal | ACP | Verdict |
|---|---|---|
| `statusReport`, `mcpReport`, `measureContext`, `expandMentions`, `reviewPrompt`, `INIT_PROMPT`, `PERMISSION_PRESETS`, `createIdleCompaction` | called, not copied | none |
| `session-controller.ts`: undo, fork, goal calls, reopening with another model or mode | `sessions.ts`: the same few steps (about 15 lines each for undo and fork, 2 lines for each goal call; the rebuild-and-restore-on-failure about 20 lines) | small duplication |
| `/permissions` and the Shift+Tab cycle (`nextPermission`) | the mode selector over `PERMISSION_NAMES` | none: different questions |

**A shared function for undo, fork and reopen: not recommended.** The owner asked to judge this carefully because the terminal works well. The duplicated code is about 50 lines; moving it into a shared module means editing `session-controller.ts` and its 30-odd tests, adding a module both front ends depend on, and gaining no behaviour. If one side's rules change later (for instance `/fork` learns to take a title), the other is a few lines to follow. Leave as it is; record the duplication here so it is a known thing and not a surprise.

**Ranked list of possible changes** (size, risk, advice)

| # | Change | Size | Risk | Advice |
|---|---|---|---|---|
| 1 | Split the `prompt` handler in `agent.ts` into `runCommand` (the commands that do not start a turn) and `runTurn`, as two functions in the same file | about 40 lines moved | low (covered by the L2 command tests) | **Dropped** (owner: not needed; it reads well and is tested). |
| 2 | Drop the unused `features()`/`readClientFeatures` until phase A4 | about 25 lines out | low | **Done** (owner's decision). |
| 3 | Merge `auth.ts` into `sessions.ts`, and `attachments.ts` into `content.ts`' neighbour only if a second user appears | 2 files out | low | **Dropped**: a few dozen lines of small calls stay as they are (owner). `sessions.ts` keeps its call to `providerFor`. |
| 4 | Move reconfiguration (provider choices, view, modes, rebuild, pending) out of `sessions.ts` into its own file | about 120 lines moved | medium (it shares the entries state and the `switching` flag with turn control) | **Not now; decided to leave** (owner). Look again only if a fourth selector is added or the file passes about 450 lines. |
| 5 | Extract undo, fork and reopen shared with the terminal | about 50 lines | medium (touches the working terminal and its tests) | Do not. |
| 6 | Let `agent.ts` reach the framework agent directly for goal, undo, fork, mcp to drop the thin wrappers | about 50 lines out of `sessions.ts` | medium (leaks the framework type into the core's top layer) | Do not. |

**Files outside `src/acp/` touched by this work** (all small): `cli.ts` (the `acp` branch, about 8 lines), `invocation.ts` (one case), `agent-session.ts` (one optional field, `extraPlugins`), `slash-commands.ts` (`INIT_PROMPT` exported). No other terminal code was changed.

## Should a review refusal become a permission prompt? (C4: decision, not built)

Today a refused tool call goes back to the agent as a tool error and the person is not asked: Sakura reviews every call itself (hard rules first, then a reviewer model) and `session/request_permission` is never called. The question is whether some refusals should become a prompt to the person in the client.

| For | Against |
|---|---|
| A false refusal can be overridden by the person at once; today the person can only reword the request and hope. | The framework has no way to approve one refused call. The review plugin decides inside the tool call; asking the person needs a new decision kind ("ask") in the kernel that pauses the call and resumes it, and edits to `packages/kernel/**` are outside this work. |
| It is what ACP clients expect (T3 Code shows permission prompts); the mode selector alone cannot express "allow this once". | Prompt fatigue and unattended work: a goal that runs for an hour would stop at every refusal; the design point of Sakura is that no human approval is needed. |
| A reviewer that is unsure could ask instead of guessing. | A prompt is a way for an injected instruction to get a human click; hard-rule refusals (secrets, catastrophic commands) must never be overridable, so only a subset would qualify, which is more to explain and to test. |
| Builds trust in the first minutes of use. | Clients differ in how they handle prompts; a client that ignores them would block the call forever unless there is a timeout and a default. |

**Decision: do not implement now.** The mode selector (C1) already lets the person choose how strict the review is, and `strict` pauses the run after repeated refusals. Revisit when the kernel can return an "ask" decision. Sketch for then: only refusals from the reviewer model (never the hard rules) become `session/request_permission` with the options "allow once" and "reject"; the default on timeout or cancel is reject; the answer is logged with the review decision.

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-11 | ACP v1 with SDK 2.4.0, exact pin, stable entry point | Newest release older than seven days; v2 is a draft. |
| 2026-11-11 | Stdout is protocol only; `console.*` goes to stderr | Anything else corrupts the stream. |
| 2026-11-11 | Review mode `auto` by default; `full-access` only when asked for on the command line, never by the client or the config file alone | Nothing is reviewed in it. |
| 2026-11-11 | Old file content for a `write` diff comes from a `tool.before` hook, not from events | Events reach the client after the tool may have run. |
| 2026-11-11 | `session/load` replays through the live mapper | A loaded conversation looks like the streamed one. |
| 2026-11-11 | `/redaction` not offered; `/help`, `/new`, `/clear`, `/resume`, `/rename`, `/exit`, `/diff` left to the client | Rarely flipped mid-chat; the client has the others. |
| 2026-11-11 | `@path` expansion reuses `expandMentions` | Same behaviour as the terminal, no new code. |
| 2026-11-11 | No shared function for undo, fork and reopen with the terminal | About 50 lines; the terminal works and has its own tests (owner). |
| 2026-11-11 | Review refusals do not become permission prompts yet | Needs a kernel decision kind; see the note above. |
| 2026-11-11 | ACP does not have to be independent of the rest of the product; the goal is that a change in one component does not touch the others | Same services (config, providers, store, agent factory) serve both front ends; the direction of dependency is one way (owner) |
| 2026-11-11 | Unused `readClientFeatures` and `features()` removed; they come back with phase A4 | Dead code; about 25 lines (owner) |
| 2026-11-11 | `prompt` handler not split; `auth.ts`, `attachments.ts` stay; reconfiguration stays in `sessions.ts`; no shared undo/fork function | Small, working, tested; not worth a new layer (owner) |
| 2026-11-11 | Idle compaction in ACP with the terminal's timer and settings; a prompt during it waits | Same behaviour as the terminal; nobody is operating, so the wait is invisible (owner) |
| 2026-11-12 | Thinking selector id is `reasoning_effort` (category stays `thought_level`); level saved per session; review mode not saved (owner) | T3 Code may match on the id; a saved level survives load and fork; `full-access` is never restored. |
| 2026-11-12 | Scheduled jobs (`/loop`, `/in`, `schedule_wakeup`) fire as a turn the agent starts itself, streamed with `session/update` outside any prompt, first a `user_message_chunk` marked in `_meta.sakuracode.scheduled`; experimental | A client can only start a turn with `session/prompt`; the turn is in the session file even if the client shows nothing. Details: `schedule-design.md`. |
