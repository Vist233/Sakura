import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { buildModelConfig, chooseProvider, listProviders, ProviderSetupError } from "../src/providers.ts";

const settings = DEFAULT_SETTINGS;

describe("providers", () => {
  it("builds the DeepSeek configuration", () => {
    const config = buildModelConfig({ settings, provider: "deepseek", sessionId: "s1", env: { DEEPSEEK_API_KEY: "k1" } });
    assert.equal(config.baseUrl, "https://api.deepseek.com");
    assert.equal(config.model, "deepseek-flash");
    assert.equal(config.apiKey, "k1");
    assert.equal(config.compat?.vendor, "deepseek");
    assert.equal(config.headers, undefined);
  });

  it("OpenCode Go carries the session header, which the endpoint requires", () => {
    const config = buildModelConfig({ settings, provider: "opencode", sessionId: "11111111-2222", env: { OPENCODE_API_KEY: "k2" } });
    assert.equal(config.baseUrl, "https://opencode.ai/zen/go/v1");
    assert.equal(config.model, "deepseek-v4.1-flash");
    assert.deepEqual(config.headers, { "x-opencode-session": "11111111-2222" });
  });

  it("a model override wins over the provider default", () => {
    assert.equal(buildModelConfig({ settings, provider: "deepseek", model: "other", sessionId: "s", env: { DEEPSEEK_API_KEY: "k" } }).model, "other");
  });

  it("names the missing variable but never a key", () => {
    assert.throws(
      () => buildModelConfig({ settings, provider: "opencode", sessionId: "s", env: { DEEPSEEK_API_KEY: "secret-value" } }),
      (error: Error) => error instanceof ProviderSetupError && error.message.includes("OPENCODE_API_KEY") && !error.message.includes("secret-value"),
    );
  });

  it("chooses the explicit provider, else the first with a key", () => {
    assert.equal(chooseProvider({ ...settings, provider: "opencode" }, {}), "opencode");
    assert.equal(chooseProvider(settings, { OPENCODE_API_KEY: "x" }), "opencode");
    assert.equal(chooseProvider(settings, { OPENCODE_API_KEY: "x", DEEPSEEK_API_KEY: "y" }), "deepseek");
    assert.throws(() => chooseProvider(settings, {}), /no API key found/);
    assert.throws(() => chooseProvider({ ...settings, provider: "nope" }, {}), /unknown provider "nope"/);
  });

  it("user-defined providers extend and may override the built-in list", () => {
    const custom = { ...settings, providers: { lab: { baseUrl: "https://x.test/v1", model: "m", keyEnv: "LAB_KEY", contextWindow: 1000, headers: { a: "b" } } } };
    const config = buildModelConfig({ settings: custom, provider: "lab", sessionId: "s", env: { LAB_KEY: "k" } });
    assert.deepEqual(config.headers, { a: "b" });
    assert.equal(config.compat, undefined);
    assert.deepEqual(listProviders(custom, { LAB_KEY: "k" }).map((entry) => [entry.name, entry.keyPresent, entry.builtin]), [
      ["deepseek", false, true],
      ["opencode", false, true],
      ["lab", true, false],
    ]);
  });

  it("rejects an unknown compat preset", () => {
    const custom = { ...settings, providers: { lab: { baseUrl: "u", model: "m", keyEnv: "K", contextWindow: 1, compat: "zzz" } } };
    assert.throws(() => buildModelConfig({ settings: custom, provider: "lab", sessionId: "s", env: { K: "k" } }), /unknown compat preset/);
  });
});
