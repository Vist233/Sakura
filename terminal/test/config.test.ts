import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, parseConfig, resolveSettings, emptyFileConfig, configDirectory } from "../src/config.ts";

const sample = `
provider = "opencode"
permissions = "strict"
max_tokens = 4000

[profiles.fast]
provider = "deepseek"
thinking = "low"
redaction = true

[providers.lab]
base_url = "https://example.test/v1"
model = "m1"
key_env = "LAB_KEY"
headers = { "x-a" = "b" }
session_header = "x-session"

[mcp.servers.files]
command = "npx"
args = ["-y", "srv"]
`;

describe("config", () => {
  it("reads the file, profiles, providers and mcp servers", () => {
    const file = parseConfig(sample);
    assert.equal(file.provider, "opencode");
    assert.equal(file.maxTokens, 4000);
    assert.deepEqual(file.profiles.fast, { provider: "deepseek", thinking: "low", redaction: true });
    assert.deepEqual(file.providers.lab, { baseUrl: "https://example.test/v1", model: "m1", keyEnv: "LAB_KEY", contextWindow: 128000, headers: { "x-a": "b" }, sessionHeader: "x-session" });
    assert.deepEqual(file.mcpServers.files, { command: "npx", args: ["-y", "srv"] });
  });

  it("defaults: review preset auto, redaction off, no provider chosen", () => {
    const settings = resolveSettings({ file: emptyFileConfig(), env: {} });
    assert.equal(settings.permissions, "auto");
    assert.equal(settings.redaction, false);
    assert.equal(settings.provider, undefined);
  });

  it("applies file < profile < environment < flags", () => {
    const file = parseConfig(sample);
    assert.equal(resolveSettings({ file, env: {} }).provider, "opencode");
    assert.equal(resolveSettings({ file, profile: "fast", env: {} }).provider, "deepseek");
    assert.equal(resolveSettings({ file, profile: "fast", env: { SAKURA_PROVIDER: "lab" } }).provider, "lab");
    assert.equal(resolveSettings({ file, profile: "fast", env: { SAKURA_PROVIDER: "lab" }, flags: { provider: "opencode" } }).provider, "opencode");
    const fast = resolveSettings({ file, profile: "fast", env: {} });
    assert.equal(fast.redaction, true);
    assert.equal(fast.permissions, "strict");
    assert.equal(fast.thinking, "low");
  });

  it("idle compaction: defaults, file values and a profile override", () => {
    assert.deepEqual(
      (({ cacheTtlMinutes, autoCompactMinTokens, autoCompactIdle }) => ({ cacheTtlMinutes, autoCompactMinTokens, autoCompactIdle }))(resolveSettings({ file: emptyFileConfig(), env: {} })),
      { cacheTtlMinutes: 5, autoCompactMinTokens: 20_000, autoCompactIdle: true },
    );
    const file = parseConfig('cache_ttl_minutes = 10\nauto_compact_min_tokens = 30000\n[profiles.quiet]\nauto_compact_idle = false\n');
    const base = resolveSettings({ file, env: {} });
    assert.deepEqual([base.cacheTtlMinutes, base.autoCompactMinTokens, base.autoCompactIdle], [10, 30_000, true]);
    assert.equal(resolveSettings({ file, profile: "quiet", env: {} }).autoCompactIdle, false);
    assert.throws(() => parseConfig("auto_compact_idle = 1"), /auto_compact_idle must be true or false/);
    assert.throws(() => parseConfig("cache_ttl_minutes = 0"), /positive integer/);
  });

  it("a flag that is not set does not hide the file value", () => {
    const file = parseConfig(sample);
    assert.equal(resolveSettings({ file, env: {}, flags: { provider: undefined } }).provider, "opencode");
  });

  it("rejects unknown profiles, keys and bad values with a clear message", () => {
    assert.throws(() => resolveSettings({ file: parseConfig(sample), profile: "nope", env: {} }), /unknown profile "nope"/);
    assert.throws(() => parseConfig('colour = "red"'), /unknown setting "colour"/);
    assert.throws(() => parseConfig('permissions = "root"'), /unknown permissions preset/);
    assert.throws(() => parseConfig('thinking = "max"'), /thinking must be/);
    assert.throws(() => parseConfig("redaction = 1"), /redaction must be/);
    assert.throws(() => parseConfig("[providers.x]\nmodel = \"m\""), /needs base_url/);
    assert.throws(() => parseConfig("a = "), ConfigError);
  });

  it("config directory comes from SAKURA_HOME or the home directory", () => {
    assert.equal(configDirectory({ SAKURA_HOME: "/x" }, "/home/u"), "/x");
    assert.equal(configDirectory({}, "/home/u"), "/home/u/.sakura");
  });
});
