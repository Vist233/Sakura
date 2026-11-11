// The dependency rules of src/acp/ (docs/acp-design.md), checked on the import lines of the source files.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const source = new URL("../../src/", import.meta.url).pathname;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []));
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

const all = files(source).map((file) => ({ name: relative(source, file), imports: importsOf(file) }));
const acp = all.filter((file) => file.name.startsWith("acp/"));

describe("ACP module boundaries", () => {
  it("finds the modules it is meant to check", () => {
    assert.ok(acp.length >= 10, acp.map((file) => file.name).join(", "));
  });

  it("only connection.ts imports the ACP SDK, and nothing else in src does", () => {
    const importers = all.filter((file) => file.imports.some((specifier) => specifier.startsWith("@agentclientprotocol/"))).map((file) => file.name);
    assert.deepEqual(importers, ["acp/connection.ts"]);
  });

  it("acp modules reach the framework only through framework.ts and never import the TUI", () => {
    for (const file of acp) {
      for (const specifier of file.imports) {
        assert.ok(!(specifier.startsWith(".") && /(^|\/)sdk(\/|$)|packages\//.test(specifier)) && !specifier.startsWith("@sakura/"), `${file.name} imports ${specifier}`);
        assert.ok(!/tui\//.test(specifier), `${file.name} imports ${specifier}`);
      }
    }
  });

  it("only cli.ts imports the acp modules from outside", () => {
    const outside = all.filter((file) => !file.name.startsWith("acp/") && file.imports.some((specifier) => /(^|\/)acp\//.test(specifier))).map((file) => file.name);
    assert.deepEqual(outside, ["cli.ts"]);
  });

  it("the pure mappers import nothing but types, each other and the framework seam", () => {
    for (const name of ["acp/events-to-updates.ts", "acp/content.ts", "acp/stop-reasons.ts", "acp/capabilities.ts", "acp/tool-mapping.ts", "acp/commands.ts", "acp/config-options.ts"]) {
      const imports = all.find((file) => file.name === name)!.imports;
      for (const specifier of imports) assert.ok(/^(\.\/types\.ts|\.\/tool-mapping\.ts|\.\.\/framework\.ts|\.\.\/permissions\.ts|node:crypto|node:path)$/.test(specifier), `${name} imports ${specifier}`);
    }
  });
});
