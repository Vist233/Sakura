import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without type declarations
import { checkBoundaries } from "../check-boundaries.mjs";

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "boundaries-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("checkBoundaries", () => {
  it("accepts a clean repository", () => {
    const root = makeRepo({
      "packages/kernel/src/index.ts": 'import { readFileSync } from "node:fs";\nimport { a } from "./a.ts";',
      "packages/llm/src/index.ts": 'import type { X } from "@sakura/kernel";',
      "packages/plugins/tools/src/index.ts": 'import type { X } from "@sakura/kernel";',
    });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("rejects kernel importing another package", () => {
    const root = makeRepo({ "packages/kernel/src/index.ts": 'import { y } from "@sakura/llm";' });
    expect(checkBoundaries(root)).toHaveLength(1);
  });

  it("rejects one plugin importing another", () => {
    const root = makeRepo({ "packages/plugins/review/src/index.ts": 'import { z } from "@sakura/plugin-tools";' });
    expect(checkBoundaries(root)[0]).toContain("may not import");
  });

  it("rejects deep imports into another package", () => {
    const root = makeRepo({ "packages/agent/src/index.ts": 'import { z } from "@sakura/kernel/src/loop.ts";' });
    expect(checkBoundaries(root)[0]).toContain("deep import");
  });

  it("rejects relative imports that leave the package", () => {
    const root = makeRepo({ "packages/llm/src/index.ts": 'import { z } from "../../kernel/src/index.ts";' });
    expect(checkBoundaries(root)[0]).toContain("leaves its package");
  });

  it("rejects external runtime dependencies but allows vitest in tests", () => {
    const root = makeRepo({
      "packages/env/src/index.ts": 'import x from "left-pad";',
      "packages/env/test/a.test.ts": 'import { it } from "vitest";',
    });
    expect(checkBoundaries(root)).toHaveLength(1);
  });

  it("lets the agent package use any public package", () => {
    const root = makeRepo({
      "packages/agent/src/index.ts": 'import a from "@sakura/kernel";\nimport b from "@sakura/plugin-tools";',
    });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("ignores import-like words inside strings", () => {
    const root = makeRepo({ "packages/kernel/src/a.ts": 'const text = `Move items from "In Progress" to "Done"`;\nconst other = "import x from \'y\'";' });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("sees multi-line imports and re-exports", () => {
    const root = makeRepo({
      "packages/llm/src/a.ts": 'import {\n  a,\n  b,\n} from "left-pad";',
      "packages/llm/src/b.ts": 'export * from "right-pad";',
      "packages/llm/src/c.ts": 'const x = await import("down-pad");',
    });
    expect(checkBoundaries(root)).toHaveLength(3);
  });
});
