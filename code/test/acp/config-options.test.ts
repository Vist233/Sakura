import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChange, buildConfigOptions, thinkingFor } from "../../src/acp/config-options.ts";
import type { ProviderChoice } from "../../src/acp/config-options.ts";
import { AcpError } from "../../src/acp/types.ts";

const providers: ProviderChoice[] = [
  { name: "deepseek", model: "deepseek-flash", keyEnv: "DEEPSEEK_API_KEY", available: true, thinking: true },
  { name: "opencode", model: "deepseek-v4.1-flash", keyEnv: "OPENCODE_API_KEY", available: false, thinking: true },
  { name: "commandcode", model: "deepseek/deepseek-v4-flash", keyEnv: "COMMANDCODE_API_KEY", available: true, thinking: true },
  { name: "plain", model: "plain-model", keyEnv: "PLAIN_KEY", available: true, thinking: false },
];

const codeOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof AcpError);
    return error.code;
  }
  return undefined;
};

describe("config options (L1)", () => {
  it("lists every configured provider as a model, with the one in use selected", () => {
    const [model, thinking] = buildConfigOptions(providers, { provider: "deepseek", thinking: "high" });
    assert.equal(model!.category, "model");
    assert.equal(model!.currentValue, "deepseek");
    assert.deepEqual(model!.options.map((option) => option.value), ["deepseek", "opencode", "commandcode", "plain"]);
    assert.deepEqual(model!.options.map((option) => option.name), ["deepseek-flash", "deepseek-v4.1-flash", "deepseek/deepseek-v4-flash", "plain-model"]);
    assert.match(model!.options[1]!.description ?? "", /OPENCODE_API_KEY/, "a provider without a key says which variable to set");
    assert.equal(thinking!.category, "thought_level");
    assert.equal(thinking!.currentValue, "high");
    assert.deepEqual(thinking!.options.map((option) => option.value), ["off", "low", "medium", "high"]);
  });

  it("shows no thinking level for a model that has none, and the default for one that has but was not told", () => {
    assert.equal(buildConfigOptions(providers, { provider: "plain", thinking: undefined }).length, 1);
    assert.equal(buildConfigOptions(providers, { provider: "deepseek", thinking: undefined })[1]!.currentValue, "medium");
  });

  it("option values are unique and the current value is always one of them", () => {
    for (const provider of providers) {
      for (const option of buildConfigOptions(providers, { provider: provider.name, thinking: "low" })) {
        assert.ok(option.options.some((entry) => entry.value === option.currentValue), `${option.id} for ${provider.name}`);
        assert.equal(new Set(option.options.map((entry) => entry.value)).size, option.options.length);
      }
    }
  });

  it("switches the model and keeps the thinking level where the new model has one", () => {
    assert.deepEqual(applyChange(providers, { provider: "deepseek", thinking: "low" }, "model", "commandcode"), { provider: "commandcode", thinking: "low" });
    assert.deepEqual(applyChange(providers, { provider: "deepseek", thinking: "low" }, "model", "plain"), { provider: "plain", thinking: undefined });
    assert.deepEqual(applyChange(providers, { provider: "plain", thinking: undefined }, "model", "deepseek"), { provider: "deepseek", thinking: "medium" });
  });

  it("sets the thinking level", () => {
    assert.deepEqual(applyChange(providers, { provider: "deepseek", thinking: "low" }, "thought_level", "off"), { provider: "deepseek", thinking: "off" });
  });

  it("answers bad changes with the right error", () => {
    const here = { provider: "deepseek", thinking: "low" } as const;
    assert.equal(codeOf(() => applyChange(providers, here, "model", "nope")), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "model", "opencode")), -32000, "no key: authentication is required");
    assert.equal(codeOf(() => applyChange(providers, here, "thought_level", "extreme")), -32602);
    assert.equal(codeOf(() => applyChange(providers, { provider: "plain", thinking: undefined }, "thought_level", "low")), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "colour", "red")), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "model", true)), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "model", undefined)), -32602);
  });

  it("thinkingFor", () => {
    assert.equal(thinkingFor(undefined, "low"), undefined);
    assert.equal(thinkingFor(providers[3], "low"), undefined);
    assert.equal(thinkingFor(providers[0], undefined), "medium");
  });
});
