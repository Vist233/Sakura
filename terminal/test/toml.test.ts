import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToml } from "../src/toml.ts";

describe("toml", () => {
  it("reads scalars, comments and tables", () => {
    const parsed = parseToml(`
# comment
provider = "opencode"   # trailing
count = 1_000
ratio = 0.5
flag = true
literal = 'C:\\path'

[profiles.fast]
model = "m"
[providers."my lab"]
key_env = "X"
`);
    assert.deepEqual(parsed, {
      provider: "opencode",
      count: 1000,
      ratio: 0.5,
      flag: true,
      literal: "C:\\path",
      profiles: { fast: { model: "m" } },
      providers: { "my lab": { key_env: "X" } },
    });
  });

  it("reads arrays over several lines and inline tables", () => {
    const parsed = parseToml(`args = [
  "-y",   # why
  "server",
]
env = { A = "1", B = "two words" }
dotted.key = 3
`);
    assert.deepEqual(parsed, { args: ["-y", "server"], env: { A: "1", B: "two words" }, dotted: { key: 3 } });
  });

  it("keeps a # inside a string and reads escapes", () => {
    assert.deepEqual(parseToml('a = "x # y\\n\\u00e9"'), { a: "x # y\né" });
  });

  it("reports errors with the line number", () => {
    assert.throws(() => parseToml("a = 1\nb = nope"), /line 2/);
    assert.throws(() => parseToml("a = 1\na = 2"), /duplicate key a/);
    assert.throws(() => parseToml("[a"), /must end with/);
    assert.throws(() => parseToml("[[a]]"), /not supported/);
    assert.throws(() => parseToml('a = "open'), /unterminated/);
    assert.throws(() => parseToml("a = 1\n[a]"), /not a table/);
  });
});
