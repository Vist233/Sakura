// The offline suite must never call a real model (it would cost money and fail without a key). Live tests are kept apart.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (name === "node_modules" ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));

describe("offline tests stay offline", () => {
  it("no live test file sits where the offline projects look", () => {
    const config = readFileSync(join(root, "vitest.config.ts"), "utf8");
    expect(config).not.toContain("live");
    expect(walk(join(root, "packages")).filter((file) => /\.live\./.test(file))).toEqual([]);
  });

  it("offline test files never read an API key from the environment (handing a fake one to a child process is fine)", () => {
    const offline = walk(join(root, "packages")).filter((file) => file.endsWith(".test.ts"));
    for (const file of offline) expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env(\.|\[["'])(DEEPSEEK|MOONSHOT|KIMI|OPENCODE)_API_KEY/);
  });
});
