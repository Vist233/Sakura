# Third-party notices

This file registers every piece of third-party code that is copied, ported, or
vendored into this repository. Entries under "Copied or ported" are the authoritative list; the
"Planned sources" table lists upstream projects we may still borrow from.

Rule: borrowing a design idea does not need an entry. Copying or porting code
(including translating it to another language) does. Each ported file must carry
a header comment naming its source, and a check script must fail the build when a
ported file has no header (planned for milestone M0).

## Copied or ported

### packages/plugins/tools/src/edit-match.ts
- Source: Pi (`pi-mono`), path `packages/coding-agent/src/core/tools/edit-diff.ts`, source snapshot dated 2026-10-04 (npm 1.5.0 was current at the time)
- Licence: MIT
- Copyright: Copyright (c) 2025 Mario Zechner
- Changes: removed the diff-rendering helpers and the file-system and `diff` package imports; restructured into one `applyEdits` function; kept the fuzzy matching, line-ending handling, overlap detection, line-preserving replacement and the error messages
- Licence text: `licenses/pi-mono-MIT.txt`

### packages/plugins/tools/src/builtin/{read,write,edit,bash}.ts (tool descriptions)
- Source: Pi (`pi-mono`), `packages/coding-agent/src/core/tools/{read,write,edit,bash}.ts` (description texts); the implementations are written fresh
- Licence: MIT
- Copyright: Copyright (c) 2025 Mario Zechner
- Changes: shortened and reworded for our tool contracts (timeouts, non-interactive commands)
- Licence text: `licenses/pi-mono-MIT.txt`

### packages/agent/src/system-prompt.ts (rule texts)
- Source: Pi (`pi-mono`) `packages/coding-agent/src/core/system-prompt.ts` and tool prompt snippets (structure and some rules); OpenAI Codex `codex-rs/protocol/src/prompts/base_instructions/default.md` (task-execution, validation and final-message principles)
- Licence: Pi MIT; Codex Apache-2.0
- Copyright: Copyright (c) 2025 Mario Zechner (Pi); OpenAI (Codex)
- Changes: principles condensed and reworded into 11 general rules plus per-tool rules; no text copied verbatim from Codex; Pi's section layout (preamble, tools, rules, environment) followed
- Licence text: `licenses/pi-mono-MIT.txt`, `licenses/codex-Apache-2.0.txt`

### packages/plugins/redaction/src/rules.gen.ts (generated)
- Source: gitleaks (`gitleaks/gitleaks`), `config/gitleaks.toml`, source snapshot dated 2026-11-06. The public workspace includes the generated rule table.
- Licence: MIT
- Copyright: Copyright (c) 2019 Zachary Rice
- Changes: converted by `scripts/gen-secret-rules.py` into TypeScript data (regular expressions translated to JavaScript, 22 of 221 rules skipped because they do not translate; allowlists not used)
- Licence text: `licenses/gitleaks-MIT.txt`

## Planned sources (not yet copied)

| Source | Licence | Upstream | Intended use | Status |
|---|---|---|---|---|
| Pi (`pi-mono`) | MIT, copyright Mario Zechner | `earendil-works/pi` | Edit-tool matching and the read/write/edit/bash tool descriptions are now ported (see below); system-prompt structure may follow; mcp client and codemode ideas | partly copied (see below) |
| Magpie | MIT | `yetone/magpie` | Design reference for redaction (stable placeholders, streaming restore, fail closed). Not a code port any more (decision: only the essence) | not copied |
| gitleaks | MIT (Zachary Rice) | `gitleaks/gitleaks` | Rule table converted for the redaction plugin (see above) | copied (see above) |
| Codex | Apache-2.0 | `openai/codex` | Design reference (guardian reviewer, goal, compaction); base-instructions principles adapted into our system prompt (`protocol/src/prompts/base_instructions/default.md`), with changes noted. Other prompt texts are written fresh; if any text or code is copied, add an entry and keep the Apache-2.0 notice | not copied |
| A2A | Apache-2.0 | `a2aproject/A2A` | Possible future protocol reference | not copied |
| `quickjs-emscripten` | MIT (Fabrice Bellard's QuickJS, Jake Teton-Landis's bindings; checked on npm, all 7 installed packages report MIT) | npm | Runtime dependency of `packages/plugins/toolset` (codemode sandbox). Not copied, only installed. `quickjs-wasi` was the other candidate (also MIT), not used | dependency |
| Mastra | not verified (GitHub reports NOASSERTION) | `mastra-ai/mastra` | Design reference only. **Do not copy code until the licence is read.** | not copied |

## Entry format (use when code is actually copied or ported)

```
### <file or component in this repo>
- Source: <repository URL>, path <path>, commit <hash>
- Licence: <SPDX id>
- Copyright: <holder, year>
- Changes: <what was changed or translated>
- Licence text: <path to the full licence text kept in this repository>
```
