# Scheduled wake-ups

Status: implemented, not released. Applies to the terminal and to `sakuracode acp`.

## What

A session can start a turn by itself at a chosen time. Two ways to ask for it, one scheduler behind both:

1. **The user**: `/loop <interval> <prompt>` (recurring), `/in <duration> <prompt>` (once), `/loop` (list), `/loop stop|pause|resume [id]`.
2. **The agent**: a tool `schedule_wakeup(minutes, reason)`: "wake me in N minutes". 1 to 60 minutes (clamped), one pending self wake-up at a time (a new call replaces the pending one), a cap on how many it may schedule in a session. On by default.

A fire is an ordinary turn started as if the user had sent the text. The text is prefixed (`[scheduled task]`, `[wake-up you asked for]`) so the model knows why it is awake. Nothing in the framework changes.

## Where

| File | Role |
|---|---|
| `src/schedule.ts` | The whole mechanism, pure: spec parsing, the scheduler (jobs, limits, timing from an injected clock), the command parser/formatter shared by both front ends, the persistence helper. No UI, no timers except through the clock. |
| `src/schedule-tool.ts` | A framework plugin that registers `schedule_wakeup` on top of a scheduler. |
| `src/config.ts` | `[schedule]` settings (`ScheduleSettings`, `DEFAULT_SCHEDULE`). |
| `src/session-controller.ts`, `src/slash-commands.ts`, `src/status-line.ts`, `src/reports.ts`, `src/tui/app.ts` | Terminal adapter: owns one scheduler per controller, fires through `startPrompt`, `/loop` and `/in`, the `⏰ n` indicator, the `typing` check. |
| `src/acp/sessions.ts`, `src/acp/agent.ts`, `src/acp/commands.ts`, `src/acp/serve.ts` | ACP adapter: one scheduler per open session, fires through the same turn-streaming code as a prompt, `/loop` and `/in` in the command menu, a row in `/status`. |

This is the pattern of `idle-compaction.ts` + `acp/idle.ts`: the timing lives once, the adapters only say "busy?", "typing?" and "run this".

## Rules

- Spec: `5m`, `every 30m`, `in 20m`, `2h`, `1d` (units `s m h d`, also `min`, `hours`, ...). `/loop` makes a recurring job, `/in` a one-time job; the words `every` and `in` are optional. Cron expressions are not supported; the job keeps its timing in `everyMs`, and another way to say "when" would be a field next to it.
- A job: `id` (1, 2, 3, ...), `prompt`, `kind` (`once | interval | wakeup`), `everyMs`, `nextAt`, `runs`, `lastRunAt`, `paused`, `createdAt`, `expiresAt`, `failures`.
- **Busy**: when a job is due and the session is busy, nothing is queued. The job stays due and fires once when the session is idle (a short settle delay after the run ends). An interval job is re-armed from the end of its run, so a long outage or a long turn never causes a catch-up storm.
- **Typing** (terminal): while the composer holds text or a picker is open, the fire is retried later (the rule of idle compaction).
- Several jobs due at once fire one after the other, each once.
- Limits (settings in `config.toml` under `[schedule]`): `enabled = true`, `min_interval_minutes = 1`, `max_jobs = 10` (per session, wake-up included), `max_runs = 200` (per job; also the cap of self wake-ups per session), `expire_days = 30`, `wakeup_tool = true`, `jitter_percent = 0` (an interval job fires up to that share of its interval late; off by default).
- A job removes itself after 3 failed turns in a row, on a quota/limit stop (`paused` for quota, or a provider quota/rate-limit error), when it reaches `max_runs`, or at `expiresAt`. A message tells the user why.
- Permissions: an unattended turn runs with the session's current permission mode and review behaviour. Nothing new. `schedule_wakeup` has effect `read` (it only touches the session's own timer), so it never needs a review call; the turn it causes is reviewed like any other.
- Not in `sakuracode exec` (it ends when the answer is done). For unattended work with no session open, use the OS scheduler plus `sakuracode exec` (example in `README.md`).

## Persistence

Session scoped, no daemon. The jobs are written to the session file as a `custom` entry (`customType: "schedule"`, data `{ jobs, wakeups }`, latest entry wins). `resume`, `/resume` and ACP `session/load` read the last such entry on the current branch. A job whose time has passed while the process was away fires **once** after the restore (a few seconds later in the terminal), not once per missed interval; an expired job is dropped.

The entry is written after a change, but not in the middle of a run (it would sit between a tool call and its result in the log); a change made during a run is written when the run ends. `/undo` goes back past entries, so jobs added in an undone turn disappear with it.

## ACP behaviour

A client can only start a turn with `session/prompt`; the agent cannot. So a scheduled fire runs the turn itself and streams it with `session/update` notifications **outside any prompt request**: first a `user_message_chunk` with the scheduled text and `_meta: { sakuracode: { scheduled: { id, kind } } }`, then the normal agent updates (text, tool cards, usage). This is **experimental**: whether a client shows updates that do not belong to a prompt is up to the client (T3 Code and Zed were not verified; see "Not verified"). If a client ignores them, nothing is lost: the turn is in the session file and appears with the next prompt's replay or `session/load`.

- While a scheduled turn runs, a `session/prompt` for that session waits for it to end (the same wait as idle compaction; `Sessions.run` waits for `entry.background`); `session/cancel` cancels the scheduled turn. If a prompt of the person starts in the instant between "the job is due" and "its turn starts", that run is skipped (not counted as a failure) and nothing is sent for it.
- A job that stops itself is told to the client as an `agent_message_chunk`.
- `/loop` and `/in` are in the command menu (with an input hint) and work as typed commands; `/status` has a "Scheduled" row.
- `session/load` restores the jobs and replays the scheduled turns as ordinary user/agent messages (the log has them; the `_meta` marker is live only).

## Tests

- `test/schedule.test.ts`: pure scheduler with a fake clock: spec parsing, next time, coalescing while busy (one fire), typing retry, expiry, max runs, three failures, quota stop, restore with a passed time fires once, max jobs, min interval, pause/resume/stop, jitter, persistence round trip.
- `test/schedule-tool.test.ts`: clamp, one pending (replace), count cap, effect and disabled setting.
- `test/schedule-controller.test.ts`: the terminal controller with a scripted model and the fake clock: `/loop`, the wake-up tool, busy and typing waits, the log order of the saved entry, `resume`, a new session, scheduling off.
- `test/slash-commands.test.ts`, `test/acp/tool-mapping.test.ts`: `/loop` and `/in` parsing for the terminal and ACP; `test/status-line.test.ts`: the `⏰ n` indicator only when a job is active.
- `test/acp/schedule-protocol.test.ts`: notifications are emitted outside a prompt, are marked, and are replayed by `session/load`.

## Decisions for the owner

1. A new `schedule_wakeup` call **replaces** the pending self wake-up (rather than being refused): the agent usually wants "later than I said". 
2. The self wake-up cap reuses `max_runs` (200 per session) instead of a setting of its own.
3. `/in` also has the 1 minute minimum (one rule for all user jobs).
4. Restore fires after a short delay (3 s) so the screen is up first.
5. `schedule_wakeup` is available in every review mode, `read-only` included (it has effect `read` and only moves the session's own timer; the turn it starts is reviewed or restricted like any other). If you want it off in read-only, say so.
6. Quota stops the job that hit it only; the other jobs find out on their own turn.

## Not verified

How T3 Code and Zed render updates outside a prompt. The protocol allows the notification at any time; only a real client run can tell.
