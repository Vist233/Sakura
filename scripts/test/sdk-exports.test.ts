import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "../../sdk/index.ts";

// The published package is what the README describes. Every name the README imports from it must be there, and so must the names that someone
// writing an environment, a plugin or a client needs.
const root = join(import.meta.dirname, "..", "..");

describe("the SDK offers what the README says it does", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    it(`every name ${file} imports from "sakura-agent" is exported`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const imports = [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"sakura-agent"/g)];
      expect(imports.length).toBeGreaterThan(0);
      const names = imports.flatMap((match) =>
        (match[1] ?? "").split(",").map(
          (name) =>
            name
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0] ?? "",
        ),
      );
      const missing = names.filter((name) => name !== "" && !(name in sdk));
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
});
