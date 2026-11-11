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
| `config-options.ts` | the selectors: `model` (category `model`; one entry per configured provider, value = the provider name, label = its model, so `deepseek/deepseek-v4-flash` or a 1M-window model is just a label) and `thought_level` (category `thought_level`, off/low/medium/high, only for providers whose compat preset has a thinking format); a client change to the next choice, with the right error (-32602 unknown option or value, -32000 provider without key) | yes |
| `tool-mapping.ts` | a tool call as a card: kind (`read`, `edit` for write and edit, `execute` for bash, `fetch`/`search` by name, else `other`), title, absolute locations with 1-based lines, a diff per edit and for a write, the command and its output for bash, status `completed` or `failed`; long text is cut with a note that says how much; arguments are copied with long strings cut | yes |
| `commands.ts` | the slash commands offered in the client's menu and handled inside a prompt: `/compact`, `/status`, `/goal`, `/undo`, `/fork`, `/mcp`, and `/review [focus]` and `/init`, which become the terminal's own prompts (`reviewPrompt`, `INIT_PROMPT` from `src/slash-commands.ts`); any other slash text is an ordinary prompt | yes (imports the two prompt texts) |
| `goal-notes.ts` | the goal checks the framework leaves in the session log, as short notes for the person | yes |
| `snapshot-plugin.ts` | a framework plugin (`tool.before`) that notes what a file holds before `write` replaces it, so the diff starts from the old text; the events reach the client asynchronously and could be too late | no |
| `replay.ts` | a session log as updates for `session/load`: user text as `user_message_chunk`, assistant text and tool cards through the same mapper as a live run, so a loaded conversation looks like the streamed one; message ids are the log entry ids | yes |
| `mcp.ts` | the MCP servers a client lists, as the framework's definitions (stdio only; names made safe for tool names and unique; `env` as a record); the others are counted and left out | yes |
| `attachments.ts` | writes the images of a prompt to files next to the session (`<store>/<session id>.images/<hash>.<ext>`), because the framework reads images by path | no |
| `capabilities.ts` | what the client advertised as plain booleans; our `initialize` answer (no image/audio/embedded context yet, no MCP, `loadSession` false) | yes |
| `auth.ts` | chooses the provider and turns a missing key into `auth_required` (reads whether a variable is set, never its value) | no |
| `log.ts` | JSON-line logger | yes |
| `serve.ts` | wires the parts; `runAcp` for tests, `serveProcess` for the process (stdin/stdout as web streams, console to stderr, SIGINT/SIGTERM end the run, a second signal exits at once) | no |

Rules enforced by `test/acp/boundaries.test.ts`: only `connection.ts` imports the SDK; `acp/*` reaches the framework only through `framework.ts` and never imports `tui/`; only `cli.ts` imports `acp/` from outside; the pure mappers import only `types.ts`, `framework.ts` (types) and `node:crypto`.

## Model and thinking selectors (B1)

* `session/new` returns `configOptions`; `session/set_config_option` changes one. A change rebuilds the framework agent on the same session file (the history stays), like `/model` in the terminal; the answer carries the full option list and `config_option_update` follows. Setting the value it already has does nothing.
* During a running turn the agent is not rebuilt: the change is remembered (the last one wins), the answer already shows the wanted value, and the switch happens when the turn ends, before the prompt response (so no update follows the response). If it fails, the old setup stays and the options are sent again.
* A provider whose key is not set is listed with the variable to set; choosing it answers `auth_required`. A thinking level is kept across a model change where the new model has one.
* The review mode is a third selector, see "Review mode" below.

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
