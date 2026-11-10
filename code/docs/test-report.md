# Test report

Date: 2026-11-09. Node 24.3.0, macOS. Everything below was run; failures are listed as they happened.

## 1. Offline suite (`npm test`, `npm run typecheck`)

193 tests in 24 suites, all passing, about 8 s, no network. `tsc --strict` (with `exactOptionalPropertyTypes`, `erasableSyntaxOnly`) clean.

| Layer | Suites | What is checked |
|---|---|---|
| Pure modules | toml, config, providers, permissions, ansi, markdown, transcript, keys, line-editor, slash-commands, status-line, reports, session-store, mentions/shell | each module alone, no model, no terminal |
| Painting | live-region (against a virtual terminal), screen, transcript-view | what the bottom area and the printed blocks look like |
| Real framework, scripted model | run-driver, agent-session, session-controller, exec-mode | steer/queue/cancel, tool results, failing command shows its real exit code (not `exit=0`), review denial, redaction opt-in, `/new /resume /fork /undo /compact /goal /model /permissions /redaction /status /diff /mcp /exit`, `!cmd` |
| In-process TUI | tui/app | keystrokes in, virtual terminal out: banner, prompt, Markdown reply, popup, Esc cancel, steering, `/status`, resume picker, narrow width |
| Real binary | cli, pty | child process with arguments, exit codes, `exec --json`, stdin prompt, config errors; and the binary in a real pseudo-terminal driven by keystrokes (python3 `pty`), output replayed on a virtual terminal |

Defaults are tested explicitly: review on, redaction off, no directory restriction (a tool call lists `/etc` from a temp directory), Markdown rendered.

## 2. Live runs

Keys were present in the environment and never printed. Sessions and work directories were in a scratch directory (`SAKURA_HOME` set). Models: DeepSeek `deepseek-flash`, OpenCode Go `deepseek-v4.1-flash`.

| Run | DeepSeek | OpenCode Go |
|---|---|---|
| `exec`: create `fizz.py`, run it, report the last line | passed (write reviewed ok, bash ran, correct answer) | passed |
| `exec --resume last`: edit the file with the edit tool, rerun | passed (`range(1, 21)`) | passed; `--json` gave `session`, events, `result` lines |
| Interactive (pty): prompt, tool calls, Markdown list in the reply, `/status`, `/compact`, long request then Esc, quit, `resume --last` and a question about the earlier file | passed: `/compact` printed "context compacted (2,206 tokens before)", Esc printed "Run cancelled", resume replayed the earlier conversation | passed, same steps |
| `/review` in a git repo with a modified file | ran about ten read-only git/shell steps and produced a review; my wait pattern in the driver was too narrow, so the driver reported timeout, the screen was correct | not run |
| `/model` switch mid-session (DeepSeek, then `/model opencode`) | the code word given before the switch was returned after it: same session file, new provider | |
| `--redact` with a made-up GitHub-style token | | passed: the model wrote the file; the file held the real value; the session file also holds the real value (the framework keeps the native log unmasked) |
| Reviewer on real models | the real reviewer allowed writes and commands ("review ok" shown) | same |

### Problems found by these runs (all fixed, with tests)

1. A failing `Esc` run left the process alive (driver status 4). Fixed: explicit exit after flushing stdout (framework gap T10 records the open question).
2. Absolute paths made tool cards wrap badly ("write" alone on a line). Fixed: paths under the launch directory are shown relative.
3. After a cancelled request the next question was answered together with the cancelled task, on both providers. Fixed with a hidden note before the next prompt, also on resume when the last message was never answered (gap T8).
4. Progress lines of `exec` cut long commands at the first word; a stray reset code appeared in plain text. Fixed.
5. Found earlier by the pseudo-terminal test: table cells padded wrongly with colours on; a long directory overflowed the banner box; with review on, `ls /etc` went to the reviewer because the framework's hard rules look at the directory (T5); the terminal now gives the reviewer a policy that trusts the whole machine.

### Second round (2026-11-09, after the Codex parity review)

Offline suite now 213 tests. Live, in a pseudo-terminal with `test/live/paths.ts` (scratch directory, made-up HOME), on both providers:

| Path | DeepSeek | OpenCode Go |
|---|---|---|
| `/goal <text>`, `/goal`, `/goal clear` | passed | passed |
| `!echo shell-ok` | passed (command and output shown) | passed |
| `@note.txt` in a prompt | passed (agent read it, five-word summary); the appended path note was visible in the user block: fixed, now hidden | passed |
| `/permissions read-only` then a write request | passed: only `read` was offered; the model said it could not write | passed |
| `/permissions auto` again | passed (new test checks the tool set returns to four tools) | passed |
| `/fork`, then a message, then `/undo` | passed ("Forked into session", "Went back to before your last message") | passed |
| `/rename` | passed | passed |
| A background command (`sleep 4; echo bg-done` with `background`) | the bash tool returned "started in the background" with a log path; the model waited with `sleep` and read the log; the terminal has no wake-up, so nothing appeared by itself | same |
| `/init` | passed: `AGENTS.md` was written | passed |
| Review denial through the agent | **not produced**: asked to upload a made-up private key to a `.invalid` host, the model refused by itself before calling a tool; asked to delete made-up dotfiles in a made-up HOME, the reviewer allowed it (the user asked for exactly that) | same request: allowed |
| Review denial, real reviewer judging scripted calls (`test/live/review.ts`, nothing runs unless allowed, host under `.invalid`) | key upload piped to curl: **denied** (hard deny: secrets); `curl ... \| sh`: **denied**; `ls -la`: allowed by hard rules; `echo hello > notes.txt`: allowed | the same four outcomes |
| Images: `-i red.png` and `@red.png` (a real 96x96 solid red PNG), `exec` | answered "Red" both ways | answered "Red" both ways |

Sub-agents are not configured in the terminal, so there was nothing to run.

### Problems found in the second round (fixed, with tests)

1. The `@path` note was shown in the user block. Now hidden, like the cancel note.
2. Canned prompts of `/init` and `/review` were echoed in full (six lines). Now shown as `/init`, `/review`.
3. `-p` meant provider; Codex's `-p` is the profile. Changed (`--provider` for the provider).
4. `resume` without an id opened the latest session; Codex opens a picker. Changed. Added `fork`, `review`, `exec resume`, `--yolo`, `-o`, `/rename`, Esc twice to take the last message back, `/diff` with untracked files.
5. Images were replaced by "this model cannot read images" because the framework preset lacks `images` (gap T9, corrected). The terminal now sets it for both providers.

### Third round (after the framework fixes T1-T8; workarounds removed)

Offline suite: 214 tests, `tsc` clean. The old tests of the cancel note were replaced by one that checks the kernel's interrupted marker is kept for the model and hidden in the view; review notes are matched by call id (new test with two calls to the same tool); reasoning shows on one dim line (new test); the framework's own scripted model replaced ours.

Live, `test/live/rerun.ts`, both providers, same steps, all passed:

| Step | DeepSeek | OpenCode Go |
|---|---|---|
| Long essay request, Esc after 4 s, then "What is 2+2?" | "Run cancelled", then the answer "4" and no essay (before the fix both models resumed the essay) | same |
| Steer while `sleep 8` runs | the steering message showed as pending, was delivered, and the final answer contained STEERED | same |
| A write reviewed by the real reviewer | shown with "review ok" | same |
| `/status` | table with State idle, 6 and 5 replies | same |

The reviewer policy is now the framework default with `directoryRules: false`; `test/live/review.ts` was rerun after that change on both providers with the same four outcomes as before (key upload and `curl | sh` denied, `ls` and a file write allowed).

### Not run live, and why

* A review denial that the agent's own model walks into: both models refused risky requests themselves. The reviewer's denial is shown live only with scripted calls (see the second round) and in the offline suite.
* `/mcp` with a real server (none was started), `/model` back and forth more than once, clipboard-image paste.
* `exec` against OpenCode Go with `--redact` together with the other flags beyond the runs above; Windows; terminals other than the macOS pseudo-terminal used here; very long sessions.

## 3. Checked against Codex

The Codex slash-command page (`learn.chatgpt.com/docs/developer-commands`) was fetched; only the first 100,000 of 142,770 characters were read. It names `/goal`, `/init`, `/mcp`, `/review`, `/status` (the page text lists them without descriptions). `/model`, `/compact`, `/resume`, `/fork`, `/permissions`, `/diff`, `/new` stay "from memory", as in the feature table in `design.md`.

## 4. Known limits

* Resizing the window while the live area is shown redraws it from the new size; old lines that reflowed may stay in the scrollback.
* A reply that restarts after a dropped connection cannot unprint blocks already shown (a notice is printed).
* Streaming shows finished paragraphs rendered and the open tail dimmed; reasoning text is not shown (T1).
