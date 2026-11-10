# Codex CLI parity checklist

Source: the Codex CLI pages on `learn.chatgpt.com/docs/developer-commands?surface=cli` (CLI reference, TUI guide, slash commands), read in two parts (0-100,000 and 100,000-142,770 characters; the middle section on `exec` was only available as a summary, so exec details marked "unverified" come from that summary or from memory). Status: **match**, **differs** (with what we do), **not planned** (with the reason). Where a choice is open, see `open-questions.md` (Q numbers).

## Command line

| Codex | Ours | Status |
|---|---|---|
| `codex` / `codex "prompt"` starts the TUI | same | match |
| `-m, --model` | same | match |
| `-C, --cd DIR` | same; only changes where the agent starts | match |
| `-p, --profile NAME` | same (a `[profiles.NAME]` table in `config.toml`; Codex layers a separate file) | match (file layout differs) |
| `--provider` | ours only (Codex has `--oss --local-provider`) | differs, needed for DeepSeek/OpenCode |
| `-c key=value` config override | none | not planned (flags cover the settings; Q3) |
| `-s/--sandbox`, `-a/--ask-for-approval`, `--add-dir` | none: no sandbox by design; review presets instead (`--permissions`) | differs by design |
| `--yolo` | same (`full-access`: nothing reviewed) | match |
| `--approve-for-me` (auto review) | this is our default (`auto`) | match |
| `-i/--image FILE[,FILE]` | same, for the first prompt, interactive and `exec` | match |
| Image path pasted or dropped into the prompt | becomes an `@path`, which attaches it; `@image.png` typed by hand also attaches | match (no clipboard-image paste) |
| `--search` | none | not planned (no web tool in the framework) |
| `codex resume [ID]` picker; `--last` (current directory) | same; `--last` prefers sessions of the current directory | match |
| `resume --all`, `--include-non-interactive` | none; the picker lists all sessions | not planned |
| `codex fork [ID]` / `--last` | `fork <id|--last>` (no picker) | differs (cheap: id required) |
| `codex exec "prompt"`, `-` reads stdin | same | match |
| `exec resume [ID] [prompt]`, `--last` | same | match |
| `exec fork` | none | not planned |
| `exec --json` | JSON lines: `session`, framework events, `result` | match in spirit; event names are the framework's (unverified for Codex) |
| `exec -o/--output-last-message FILE` | same | match |
| `exec --color`, `--skip-git-repo-check`, `--ephemeral`, `--output-schema` | `--no-color` only | not planned |
| exec: progress on stderr, final message on stdout (unverified) | same | match |
| `codex review --uncommitted/--base/--commit [prompt]` | `review [--base B \| --commit SHA] [focus]` (uncommitted is the default); prints the review | match |
| `codex login/logout`, `codex update`, `codex sandbox`, `codex mcp`, `codex cloud`, `codex apply` | none (keys come from the environment) | not planned |
| exit codes of `exec` (not documented) | 0 done, 1 error, 2 usage/paused, 130 cancelled | n/a |

## Keys and composer

| Codex | Ours | Status |
|---|---|---|
| Enter injects into the current turn while working | steer | match |
| Tab queues a follow-up while working | same | match |
| Esc cancels the run | same | match |
| Esc twice on an empty composer edits the previous message and forks | goes back to before the last message and puts it in the prompt (`/undo`); no fork | differs (Q2) |
| Ctrl-C closes the session | cancels a run; clears the prompt; leaves on a second press when empty | differs (safer; Q4) |
| Up/Down draft history | same (this session's history only) | match (not persisted across sessions) |
| Ctrl-R history search | none | not planned |
| Ctrl-O copy last response | none (terminal selection works: no alternate screen) | not planned |
| `@` opens a file search | `@path` typed in full is resolved and named to the agent; no popup | differs (Q1) |
| `!cmd` runs a local command | same | match |
| Shift-Enter newline | Shift/Alt-Enter, Ctrl-J, backslash+Enter | match |
| Composer on the last rows of the window | live area padded to the bottom with newlines, no scroll region | match in effect; Codex draws a viewport, we keep the terminal's own scrollback |
| Big paste | `[Pasted Content N chars]` placeholder above 1000 characters (plus: above 5 lines), expanded on send | match for the wording and limit from memory of Codex's source; the line rule is ours |
| Idle compaction at cache expiry | `cache_ttl_minutes`, `auto_compact_min_tokens`, `auto_compact_idle` | not in Codex; requested by the owner |
| Scrollback mode (`/tui`) | inline only, scrollback kept | match for the default mode |

## Slash commands

| Codex | Ours | Status |
|---|---|---|
| `/permissions` | `/permissions [preset]` | match (presets differ) |
| `/approve` (retry a denied auto-review call) | none | not planned (Q5) |
| `/new`, `/clear` | same | match |
| `/resume`, `/fork` | same | match |
| `/rename` | same | match |
| `/compact` | same | match |
| `/diff` (includes untracked) | same | match |
| `/review` | same (default target: uncommitted) | match; no preset menu (Q6) |
| `/mention` | use `@path` | not planned |
| `/init` | writes AGENTS.md through the agent | match |
| `/goal` set/view/clear | same; no pause/resume/edit | differs (framework has no pause) |
| `/model` (model and effort) | provider and model; effort only by `--thinking`/config | differs (Q7) |
| `/status` | session, directory, model, permissions, context, input with the cached part, cache hit rate (token-weighted and median reply), output; format follows Claude Code's `/usage` Session block | match ("writable roots" does not apply) |
| `/mcp` | status of configured servers | match (no `verbose`, `login`) |
| `/exit`, `/quit` | same | match |
| `/redaction` | ours only | extra |
| `/undo` | ours only (Codex has Esc-Esc) | extra |
| `/export`, `/recap`, `/copy` | none | not planned |
| `/side`, `/btw`, `/plan`, `/skills`, `/memories`, `/presets`, `/agents`, `/subagents`, `/archive`, `/delete`, `/fast`, `/voice`, `/apps`, `/plugins`, `/hooks`, `/ide`, `/ps`, `/stop`, `/usage`, `/debug-config`, `/warnings`, `/feedback`, `/logout`, `/config`, `/keymap`, `/vim`, `/raw`, `/tui`, `/statusline`, `/title`, `/theme`, `/pets`, `/experimental`, `/import`, `/cd`, `/pwd`, `/worktree`, `/daemon`, `/app` | none | not planned: features the framework or this product does not have, or terminal preferences (no over-design) |

## Display

| Codex | Ours | Status |
|---|---|---|
| Status line: model, effort, directory, context left | same | match (not configurable) |
| Markdown rendering of replies (tables, code, links) | headings, lists, tables, fenced code (no syntax colours), links as `text (url)`, quotes | match; no syntax highlighting (Q8) |
| Streaming | finished paragraphs rendered as they complete, tail dimmed | differs (Codex streams line by line) |
| Tool/command cards with output excerpt | same, 8 lines | match |
| Approval prompts | none: automatic review decides; refused calls shown as denied with the reason | differs by design |
| Session picker | arrows, Enter, Esc | match |
