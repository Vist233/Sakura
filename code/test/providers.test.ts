import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { buildModelConfig, chooseProvider, listProviders, providerThinkingLevels, BUILTIN_PROVIDERS, ProviderSetupError } from "../src/providers.ts";

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

  it("OpenAI and Anthropic are built in, with their own presets and keys", () => {
    const openai = buildModelConfig({ settings, provider: "openai", sessionId: "s", env: { OPENAI_API_KEY: "k" } });
    assert.equal(openai.baseUrl, "https://api.openai.com/v1");
    assert.equal(openai.compat?.maxTokensField, "max_completion_tokens");
    const anthropic = buildModelConfig({ settings, provider: "anthropic", sessionId: "s", env: { ANTHROPIC_API_KEY: "k" } });
    assert.equal(anthropic.baseUrl, "https://api.anthropic.com/v1/");
    assert.equal(anthropic.compat?.maxTokensField, "max_tokens");
    assert.equal(anthropic.compat?.thinkingFormat, "none");
    assert.deepEqual(Object.keys(BUILTIN_PROVIDERS), ["deepseek", "openai", "anthropic"]);
  });

  it("a provider that wants the session id in a header gets it", () => {
    const custom = { ...settings, providers: { lab: { baseUrl: "https://x.test/v1", model: "m", keyEnv: "LAB_KEY", contextWindow: 1000, sessionHeader: "x-session" } } };
    const config = buildModelConfig({ settings: custom, provider: "lab", sessionId: "11111111-2222", env: { LAB_KEY: "k" } });
    assert.deepEqual(config.headers, { "x-session": "11111111-2222" });
  });

  it("the built-in providers use the deepseek-flash preset: Extra high and Max are offered, and Extra high is sent as High", () => {
    const levels = ["off", "low", "medium", "high", "xhigh", "max"];
    for (const provider of ["deepseek"]) {
      const definition = BUILTIN_PROVIDERS[provider]!;
      assert.equal(definition.compat, "deepseek-flash");
      assert.deepEqual(providerThinkingLevels(definition), levels);
      const config = buildModelConfig({ settings, provider, sessionId: "s", env: { [definition.keyEnv]: "k" } });
      assert.equal(config.compat?.extraHighEffort, "high");
    }
  });

  it("a provider that names another preset gets what that preset says", () => {
    const plain = { ...BUILTIN_PROVIDERS.deepseek!, compat: "deepseek" };
    assert.deepEqual(providerThinkingLevels(plain), ["off", "low", "medium", "high"]);
  });

  it("the built-in providers are set up to read images", () => {
    for (const [provider, keyEnv] of [
      ["deepseek", "DEEPSEEK_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
      ["anthropic", "ANTHROPIC_API_KEY"],
    ] as const)
      assert.equal(buildModelConfig({ settings, provider, sessionId: "s", env: { [keyEnv]: "k" } }).compat?.images, true);
    const custom = { ...settings, providers: { lab: { baseUrl: "u", model: "m", keyEnv: "K", contextWindow: 1 } } };
    assert.equal(buildModelConfig({ settings: custom, provider: "lab", sessionId: "s", env: { K: "k" } }).compat, undefined);
  });

  it("a model override wins over the provider default", () => {
    assert.equal(buildModelConfig({ settings, provider: "deepseek", model: "other", sessionId: "s", env: { DEEPSEEK_API_KEY: "k" } }).model, "other");
  });

  it("names the missing variable but never a key", () => {
    assert.throws(
      () => buildModelConfig({ settings, provider: "openai", sessionId: "s", env: { DEEPSEEK_API_KEY: "secret-value" } }),
      (error: Error) => error instanceof ProviderSetupError && error.message.includes("OPENAI_API_KEY") && !error.message.includes("secret-value"),
    );
  });

  it("chooses the explicit provider, else the first with a key", () => {
    assert.equal(chooseProvider({ ...settings, provider: "openai" }, {}), "openai");
    assert.equal(chooseProvider(settings, { ANTHROPIC_API_KEY: "x" }), "anthropic");
    assert.equal(chooseProvider(settings, { ANTHROPIC_API_KEY: "x", DEEPSEEK_API_KEY: "y" }), "deepseek");
    assert.throws(() => chooseProvider(settings, {}), /no API key found/);
    assert.throws(() => chooseProvider({ ...settings, provider: "nope" }, {}), /unknown provider "nope"/);
  });

  it("user-defined providers extend and may override the built-in list", () => {
    const custom = { ...settings, providers: { lab: { baseUrl: "https://x.test/v1", model: "m", keyEnv: "LAB_KEY", contextWindow: 1000, headers: { a: "b" } } } };
    const config = buildModelConfig({ settings: custom, provider: "lab", sessionId: "s", env: { LAB_KEY: "k" } });
    assert.deepEqual(config.headers, { a: "b" });
    assert.equal(config.compat, undefined);
    assert.deepEqual(
      listProviders(custom, { LAB_KEY: "k" }).map((entry) => [entry.name, entry.keyPresent, entry.builtin]),
      [
        ["deepseek", false, true],
        ["openai", false, true],
        ["anthropic", false, true],
        ["lab", true, false],
      ],
    );
  });

  it("rejects an unknown compat preset", () => {
    const custom = { ...settings, providers: { lab: { baseUrl: "u", model: "m", keyEnv: "K", contextWindow: 1, compat: "zzz" } } };
    assert.throws(() => buildModelConfig({ settings: custom, provider: "lab", sessionId: "s", env: { K: "k" } }), /unknown compat preset/);
  });
});
