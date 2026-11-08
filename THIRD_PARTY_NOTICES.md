# Third-party notices

Sakura borrows from a few other projects. Where code or text was copied or adapted, the source file says so in its header, and the licence text is kept in `licenses/`.

| Project | Licence | What Sakura took |
|---|---|---|
| [Pi](https://github.com/badlogic/pi-mono) (Mario Zechner) | MIT | The edit-matching code in `packages/plugins/tools/src/edit-match.ts`, and the wording of the `read`, `write`, `edit` and `bash` tool descriptions, adapted. The structure and some rules of the system prompt follow Pi's. |
| [gitleaks](https://github.com/gitleaks/gitleaks) (Zachary Rice) | MIT | The secret-detection rules in `packages/plugins/redaction/src/rules.gen.ts`, converted to TypeScript. |
| [OpenAI Codex](https://github.com/openai/codex) | Apache-2.0 | Ideas only: some task-execution principles in the system prompt, reworded. No code or text is copied. |

Dependency: [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) (MIT) runs the code-mode scripts. It is installed from npm, not copied.

Licence texts: `licenses/pi-mono-MIT.txt`, `licenses/gitleaks-MIT.txt`, `licenses/codex-Apache-2.0.txt`.
