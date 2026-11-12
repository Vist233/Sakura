import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyChange, buildConfigOptions, thinkingFor } from "../../src/acp/config-options.ts";
import type { Choice, ProviderChoice } from "../../src/acp/config-options.ts";
import type { PermissionName } from "../../src/permissions.ts";
import { AcpError } from "../../src/acp/types.ts";

const providers: ProviderChoice[] = [
  { name: "deepseek", model: "deepseek-flash", keyEnv: "DEEPSEEK_API_KEY", available: true, thinking: true },
  { name: "opencode", model: "deepseek-v4.1-flash", keyEnv: "OPENCODE_API_KEY", available: false, thinking: true },
  { name: "commandcode", model: "deepseek/deepseek-v4-flash", keyEnv: "COMMANDCODE_API_KEY", available: true, thinking: true },
  { name: "plain", model: "plain-model", keyEnv: "PLAIN_KEY", available: true, thinking: false },
];
const MODES: PermissionName[] = ["auto", "read-only", "strict"];
const choice = (provider: string, thinking: Choice["thinking"], permissions: PermissionName = "auto"): Choice => ({ provider, thinking, permissions });
const ids = (options: ReturnType<typeof buildConfigOptions>) => options.map((option) => option.id);

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
    const [model, thinking] = buildConfigOptions(providers, choice("deepseek", "high"), MODES);
    assert.equal(model!.category, "model");
    assert.equal(model!.currentValue, "deepseek");
    assert.deepEqual(model!.options.map((option) => option.value), ["deepseek", "opencode", "commandcode", "plain"]);
    assert.deepEqual(model!.options.map((option) => option.name), ["deepseek-flash (deepseek)", "deepseek-v4.1-flash (opencode)", "deepseek/deepseek-v4-flash (commandcode)", "plain-model (plain)"]);
    assert.match(model!.options[1]!.description ?? "", /OPENCODE_API_KEY/, "a provider without a key says which variable to set");
    assert.equal(thinking!.category, "thought_level");
    assert.equal(thinking!.currentValue, "high");
    assert.deepEqual(thinking!.options.map((option) => option.value), ["off", "low", "medium", "high"]);
  });

  it("offers the review modes it is given, with the preset summaries, and never full-access unless it is in the list", () => {
    const mode = buildConfigOptions(providers, choice("deepseek", "low", "strict"), MODES).find((option) => option.id === "mode")!;
    assert.equal(mode.category, "mode");
    assert.equal(mode.currentValue, "strict");
    assert.deepEqual(mode.options.map((option) => option.value), ["auto", "read-only", "strict"]);
    assert.ok(mode.options.every((option) => (option.description ?? "").length > 10));
    const withAll = buildConfigOptions(providers, choice("deepseek", "low", "full-access"), [...MODES, "full-access"]).find((option) => option.id === "mode")!;
    assert.deepEqual(withAll.options.map((option) => option.value), ["auto", "read-only", "strict", "full-access"]);
  });

  it("shows no thinking level for a model that has none, and the default for one that has but was not told", () => {
    assert.deepEqual(ids(buildConfigOptions(providers, choice("plain", undefined), MODES)), ["model", "mode"]);
    assert.equal(buildConfigOptions(providers, choice("deepseek", undefined), MODES)[1]!.currentValue, "medium");
  });

  it("option values are unique and the current value is always one of them", () => {
    for (const provider of providers) {
      for (const option of buildConfigOptions(providers, choice(provider.name, "low"), MODES)) {
        assert.ok(option.options.some((entry) => entry.value === option.currentValue), `${option.id} for ${provider.name}`);
        assert.equal(new Set(option.options.map((entry) => entry.value)).size, option.options.length);
      }
    }
  });

  it("switches the model and keeps the thinking level and mode where they still apply", () => {
    assert.deepEqual(applyChange(providers, choice("deepseek", "low", "strict"), "model", "commandcode", MODES), choice("commandcode", "low", "strict"));
    assert.deepEqual(applyChange(providers, choice("deepseek", "low"), "model", "plain", MODES), choice("plain", undefined));
    assert.deepEqual(applyChange(providers, choice("plain", undefined), "model", "deepseek", MODES), choice("deepseek", "medium"));
  });

  it("sets the thinking level and the review mode", () => {
    assert.deepEqual(applyChange(providers, choice("deepseek", "low"), "reasoning_effort", "off", MODES), choice("deepseek", "off"));
    assert.deepEqual(applyChange(providers, choice("deepseek", "low"), "mode", "read-only", MODES), choice("deepseek", "low", "read-only"));
  });

  it("full-access can be picked only when it is in the list; the refusal says how to get it", () => {
    assert.equal(codeOf(() => applyChange(providers, choice("deepseek", "low"), "mode", "full-access", MODES)), -32602);
    try {
      applyChange(providers, choice("deepseek", "low"), "mode", "full-access", MODES);
    } catch (error) {
      assert.match((error as Error).message, /--permissions full-access/);
    }
    assert.deepEqual(applyChange(providers, choice("deepseek", "low"), "mode", "full-access", [...MODES, "full-access"]), choice("deepseek", "low", "full-access"));
  });

  it("answers bad changes with the right error", () => {
    const here = choice("deepseek", "low");
    assert.equal(codeOf(() => applyChange(providers, here, "model", "nope", MODES)), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "model", "opencode", MODES)), -32000, "no key: authentication is required");
    assert.equal(codeOf(() => applyChange(providers, here, "reasoning_effort", "extreme", MODES)), -32602);
    assert.equal(codeOf(() => applyChange(providers, choice("plain", undefined), "reasoning_effort", "low", MODES)), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "mode", "yolo", MODES)), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "colour", "red", MODES)), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "model", true, MODES)), -32602);
    assert.equal(codeOf(() => applyChange(providers, here, "model", undefined, MODES)), -32602);
  });

  it("thinkingFor", () => {
    assert.equal(thinkingFor(undefined, "low"), undefined);
    assert.equal(thinkingFor(providers[3], "low"), undefined);
    assert.equal(thinkingFor(providers[0], undefined), "medium");
  });
});
