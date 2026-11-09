# Open questions

Each entry: the question, the options, my recommendation (which the code follows now).

**Q1. `@` file mentions: popup or typed path?** Options: (a) a fuzzy file popup like Codex; (b) only complete paths typed by the user are recognised. Recommendation: (b). A popup needs a file index and more UI; a typed path is enough for now and the agent can search itself.

**Q2. Esc twice on an empty prompt: fork or rewind?** Codex edits the previous message and forks from there. Options: (a) rewind the same session (`/undo`); (b) fork into a new session first. Recommendation: (a), simpler and reversible by nothing else; the old branch is kept in the session file anyway.

**Q3. `-c key=value` overrides.** Options: add a generic override flag, or keep dedicated flags. Recommendation: dedicated flags; the config has few settings.

**Q4. Ctrl-C while idle.** Codex closes the session at once. Options: (a) as Codex; (b) first press clears the prompt or warns, second leaves. Recommendation: (b), because Ctrl-C is also the natural way to clear a half-typed prompt.

**Q5. `/approve`.** Codex lets the user retry one recently denied call. There is no human approval step here, so the reviewer's refusal is final within the run; the user can say what they want in the next message (the reviewer sees the user's words) or use `--permissions full-access`. Recommendation: not add it unless the owner wants a human override; it would need a framework authorizer that asks the user (the framework has no `ask` outcome).

**Q6. `/review` presets** (base branch, commit, custom). Options: a menu in the TUI, or only the CLI subcommand with `--base/--commit`. Recommendation: CLI subcommand only; in the TUI `/review <focus>` reviews uncommitted changes.

**Q7. Reasoning effort in `/model`.** Options: `/model deepseek-flash high`, or a separate command. Recommendation: leave effort to `--thinking`/config until a provider has more than one meaningful level; DeepSeek's thinking is on/off in practice.

**Q8. Syntax highlighting of code blocks.** Options: none, a small generic highlighter, a library. Recommendation: none (cyan text); a wrong highlighter is worse than none and a library adds a dependency.

**Q9. Default provider.** With no `--provider` and both keys set, DeepSeek wins because it is listed first. Options: DeepSeek first, OpenCode first, or ask on first run. Recommendation: keep; set `provider = "..."` in the config to change it.
