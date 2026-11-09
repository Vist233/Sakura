import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "../../sdk/index.ts";
import * as testing from "../../sdk/testing.ts";

// The published package is what the README describes. Every name the README imports from it must be there, and so must the names that someone
// writing an environment, a plugin or a client needs.
const root = join(import.meta.dirname, "..", "..");

describe("the SDK offers what the README says it does", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    it(`every name ${file} imports from "sakura-agent" is exported`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const imports = [...text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"sakura-agent"/g)];
      expect(imports.length).toBeGreaterThan(0);
      const namesOf = (list: string) =>
        list
          .split(",")
          .map(
            (name) =>
              name
                .trim()
                .replace(/^type\s+/, "")
                .split(/\s+as\s+/)[0] ?? "",
          )
          .filter((name) => name !== "");
      const values = imports.filter((match) => match[1] === undefined).flatMap((match) => namesOf(match[2] ?? ""));
      const types = imports.filter((match) => match[1] !== undefined).flatMap((match) => namesOf(match[2] ?? ""));
      // a type has no runtime value: it must be named in an `export type` of the entry point (tsc checks the rest, in sdk-types.test.ts)
      const typeExports = readFileSync(join(root, "sdk", "index.ts"), "utf8");
      const missing = [...values.filter((name) => !(name in sdk)), ...types.filter((name) => !new RegExp(`\\b${name}\\b`).test(typeExports))];
      expect(missing).toEqual([]);
    });
  }

  it("the factories and classes a user of the package needs are values", () => {
    for (const name of [
      "createAgent",
      "corePlugins",
      "bundle",
      "compose",
      "CompositionError",
      "buildSystemPrompt",
      "createLocalEnvironment",
      "createRemoteEnvironment",
      "createSshEnvironment",
      "RemoteConnectionError",
      "OutsideDirectoryError",
      "compatPresets",
      "createChatClient",
      "contextPlugin",
      "toolsPlugin",
      "resiliencePlugin",
      "limitsPlugin",
      "redactionPlugin",
      "reviewPlugin",
    ]) {
      expect(typeof (sdk as Record<string, unknown>)[name], name).not.toBe("undefined");
    }
  });

  it("an error from a runner that you write can be told from other errors", () => {
    const error = new sdk.RemoteConnectionError("the connection dropped");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RemoteConnectionError");
  });

  it("a scripted model for tests is offered from its own entry point, not mixed into the main one", () => {
    expect(typeof testing.createFauxClient).toBe("function");
    expect("createFauxClient" in sdk).toBe(false);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, { import: string; types: string }> };
    expect(manifest.exports["./testing"]).toEqual({ types: "./dist/sdk/testing.d.ts", import: "./dist/sdk/testing.js" });
  });
});
