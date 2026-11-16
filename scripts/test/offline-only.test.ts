// The offline suite must never call a real model (it would cost money and fail without a key). Live tests are kept apart.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (name === "node_modules" ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));

/** The files under packages/ that belong to the repository: what a clone has, not what one machine left lying around. Without git, every file. */
const tracked = (): string[] => {
  try {
    return execFileSync("git", ["ls-files", "-z", "packages"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((file) => join(root, file));
  } catch {
    return walk(join(root, "packages"));
  }
};

describe("offline tests stay offline", () => {
  it("no live test file sits where the offline projects look", () => {
    const config = readFileSync(join(root, "vitest.config.ts"), "utf8");
    expect(config).not.toContain("live");
    expect(tracked().filter((file) => /\.live\./.test(file))).toEqual([]);
  });

  it("offline test files never read an API key from the environment (handing a fake one to a child process is fine)", () => {
    const offline = tracked().filter((file) => file.endsWith(".test.ts"));
    for (const file of offline) expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env(\.|\[["'])(DEEPSEEK|MOONSHOT|KIMI|OPENCODE)_API_KEY/);
  });
});
