# Framework gaps found while building Sakura Code

The terminal uses the framework through `sdk/index.ts` and `sdk/testing.ts` only and does not patch it. The gaps T1 to T9 and T6/T7 that this terminal first reported were fixed in the framework (commits up to `681b49e`); the workarounds were removed. What is left:

| Id | Gap | Workaround in the terminal | Proposed framework change | Priority |
|---|---|---|---|---|
| T10 | **The process did not exit after a cancelled request in a pseudo-terminal.** In the first live runs the process was still alive 5 s after `agent.close()` returned, after Esc had cancelled a streaming request. The cause was not isolated (an open socket of the cancelled fetch or a paused TTY handle are the candidates). Not rechecked after the framework changes. | `bin/sakura-code.mjs` calls `process.exit` after flushing stdout. | Find the handle that stays open (`process.getActiveResourcesInfo()` after `close()`). | Low |
| T11 | **Wake-up is not wired in the terminal.** `AgentConfig.wake` can start a run when a background command ends, but a host must show that run (`onRun`). A command that the model moves to the background is reported to the model at its next turn only. | None (a terminal task). | None. | - |
| T12 | **Sub-agents are not configured.** `AgentConfig.subAgents` works but the terminal offers no definitions. | None. | None. | - |

## Fixed in the framework, workaround removed here

| Id | What | Terminal change |
|---|---|---|
| T1 | `reasoning_update` event | the live area shows the end of the reasoning on one dim "thinking:" line; nothing is stored in the transcript |
| T2 | `message_end` (user) when a steered or queued message is taken | `run-driver.ts` no longer reads the log; it removes the message from "pending" when the event arrives |
| T3 | `message_start` before the first delta | no change needed (the transcript never depended on it) |
| T4 | `callId` on the review event | review notes are matched by call id |
| T5 | `reviewPlugin({ directoryRules: false })` | used in `permissions.ts`; the custom reviewer policy was deleted, so the framework's default policy applies |
| T6, T7 | MCP types exported; scripted model on `sakura-agent/testing` | `src/faux-client.ts` deleted; `src/framework-testing.ts` imports `../sdk/testing.ts` |
| T8 | assistant marker "[The user interrupted this request before it was answered.]" after a cancel | the cancel note and its resume handling were deleted; the view hides the marker (the "Run cancelled." line says it) |
| T9 | image support | the terminal still sets `images: true` for its providers (the `deepseek` preset itself has no `images`; both providers read images, checked live) |

## Where the framework worked as documented

`createAgent`, `run`, `queue`, `steer`, `cancel`, `rewindTo`, `fork`, `context()`, `usage()`, `goal()/setGoal()/clearGoal()`, `run(undefined, {compact: true})`, `reviewPlugin` with `breaker`, `redactionPlugin` with `wrap`, `compose` ordering, `AgentConfig.rules` and `corePlugins()` were used without changes and behaved as documented.
