# Third-party notices

This file registers every piece of third-party code that is copied, ported, or
vendored into this repository. Entries under "Copied or ported" are the authoritative list.

Rule: borrowing a design idea does not need an entry. Copying or porting code
(including translating it to another language) does.

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
- Source: gitleaks (`gitleaks/gitleaks`), `config/gitleaks.toml`, source snapshot dated 2026-11-06; the generated rule table is included.
- Licence: MIT
- Copyright: Copyright (c) 2019 Zachary Rice
- Changes: converted by a generator script (not part of this repository) into TypeScript data (regular expressions translated to JavaScript, 22 of 221 rules skipped because they do not translate; allowlists not used)
- Licence text: `licenses/gitleaks-MIT.txt`

## Dependencies

- `quickjs-emscripten` (MIT; Fabrice Bellard's QuickJS and Jake Teton-Landis's bindings): runtime dependency of `packages/plugins/toolset` (the code-mode sandbox). Installed from npm, not copied.

## Entry format (use when code is actually copied or ported)

```
### <file or component in this repo>
- Source: <repository URL>, path <path>, commit <hash>
- Licence: <SPDX id>
- Copyright: <holder, year>
- Changes: <what was changed or translated>
- Licence text: <path to the full licence text kept in this repository>
```
