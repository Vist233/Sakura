# sakuracode as an ACP agent: design and decisions

Status: phase A1 (chat) and B1 (model and thinking selectors) built. Tools, plan, usage, commands, session load and config options come in A2 and A3; client file and terminal access (A4) and the registry (A5) are not planned yet. The full plan, with sources and test levels, is `docs/46-acp-plan.md` in the framework repository (local record). This file keeps what is decided or built.

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
| `capabilities.ts` | what the client advertised as plain booleans; our `initialize` answer (no image/audio/embedded context yet, no MCP, `loadSession` false) | yes |
| `auth.ts` | chooses the provider and turns a missing key into `auth_required` (reads whether a variable is set, never its value) | no |
| `log.ts` | JSON-line logger | yes |
| `serve.ts` | wires the parts; `runAcp` for tests, `serveProcess` for the process (stdin/stdout as web streams, console to stderr, SIGINT/SIGTERM end the run, a second signal exits at once) | no |

Rules enforced by `test/acp/boundaries.test.ts`: only `connection.ts` imports the SDK; `acp/*` reaches the framework only through `framework.ts` and never imports `tui/`; only `cli.ts` imports `acp/` from outside; the pure mappers import only `types.ts`, `framework.ts` (types) and `node:crypto`.

## Model and thinking selectors (B1)

* `session/new` returns `configOptions`; `session/set_config_option` changes one. A change rebuilds the framework agent on the same session file (the history stays), like `/model` in the terminal; the answer carries the full option list and `config_option_update` follows. Setting the value it already has does nothing.
* During a running turn the agent is not rebuilt: the change is remembered (the last one wins), the answer already shows the wanted value, and the switch happens when the turn ends, before the prompt response (so no update follows the response). If it fails, the old setup stays and the options are sent again.
* A provider whose key is not set is listed with the variable to set; choosing it answers `auth_required`. A thinking level is kept across a model change where the new model has one.
* Review mode is not a selector yet (it comes from the command line).

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

Verdict of the full run: **CONFORMANT**. The one advisory failure is `ACP-SESSION-004` ("agents SHOULD connect to the MCP servers the client lists in `session/new`"): MCP servers from the client are planned for A2.

The TCK found one thing worth fixing, which is done: it exercised `$/cancel_request` (an optional cancel of one request). The agent now ends the turn when the prompt request is cancelled, like `session/cancel` (`ACP-JSONRPC-007` went from skipped to pass; covered by an L2 test).

To repeat: clone the repository at that commit into an empty directory, then run `uv run acp-tck --agent-cwd <empty dir> --agent-env SAKURA_HOME=<empty dir> --agent-env SAKURACODE_FAUX_SCRIPT=<script.json> -- node bin/sakuracode.mjs acp` with `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR` and `UV_PROJECT_ENVIRONMENT` pointing into that directory and a minimal environment (`env -i`), because the TCK passes its whole environment on to the agent.

## Not built yet

Tool call updates, plan, `usage_update`, compaction updates, slash commands inside a prompt, images and embedded resources, MCP servers from `session/new` (phase A2); `session/load`, `session/set_mode`, `session/set_config_option` (A3). A client cannot override a refused call (Sakura has no human approval step by design).
