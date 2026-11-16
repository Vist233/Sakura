import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import type { ThinkingLevel } from "@sakura/kernel";
import { compatPresets, resolveCompat } from "../src/index.ts";
import { thinkingParameters } from "../src/chat/compat.ts";
import { isRetryable } from "../src/chat/errors.ts";

const base = compatPresets.deepseek as Parameters<typeof thinkingParameters>[0];
const withFormat = (thinkingFormat: "none" | "openai" | "deepseek") => ({ ...base, thinkingFormat }) as Parameters<typeof thinkingParameters>[0];
const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];

describe("thinkingParameters", () => {
  it("maps Extra high to High only for providers that use that alias", () => {
    const compat = { ...withFormat("deepseek"), extraHighEffort: "high" as const };
    expect(thinkingParameters(compat, "xhigh")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(thinkingParameters(compat, "max")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(thinkingParameters(withFormat("deepseek"), "xhigh").reasoning_effort).toBe("xhigh");
  });
  it("no level asked, or a model without thinking, adds nothing", () => {
    expect(thinkingParameters(withFormat("deepseek"), undefined)).toEqual({});
    for (const level of levels) expect(thinkingParameters(withFormat("none"), level)).toEqual({});
  });
  it("openai format: reasoning_effort for every level but off", () => {
    expect(thinkingParameters(withFormat("openai"), "off")).toEqual({});
    for (const level of ["low", "medium", "high"] as const) expect(thinkingParameters(withFormat("openai"), level)).toEqual({ reasoning_effort: level });
  });
  it("deepseek format: an explicit enabled / disabled switch plus the effort", () => {
    expect(thinkingParameters(withFormat("deepseek"), "off")).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingParameters(withFormat("deepseek"), "high")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  });
});

describe("isRetryable", () => {
  const kinds = ["rate_limit", "overloaded", "network", "auth", "invalid_request", "context_overflow", "quota", "unknown"] as const;
  for (const kind of kinds) {
    const expected = kind === "rate_limit" || kind === "overloaded" || kind === "network";
    it(`${kind} is ${expected ? "" : "not "}retried`, () => {
      expect(isRetryable(new ProviderError(kind as never, "x"))).toBe(expected);
    });
  }
});

describe("resolveCompat", () => {
  it("a route picks its preset by name, address (trailing slash ignored) and model", () => {
    expect(resolveCompat("deepseek", "https://api.deepseek.com/", "deepseek-flash")).toBe(compatPresets["deepseek-flash"]);
    expect(resolveCompat("deepseek", "https://opencode.ai/zen/go/v1", "deepseek-v4.1-flash")).toBe(compatPresets["deepseek-flash"]);
    expect(resolveCompat("deepseek", "https://api.commandcode.ai/provider/v1", "deepseek/deepseek-v4.1-flash")).toBe(compatPresets["commandcode-deepseek"]);
  });
  it("another model, another address or another preset name gets the preset itself", () => {
    expect(resolveCompat("deepseek", "https://api.deepseek.com", "other")).toBe(compatPresets.deepseek);
    expect(resolveCompat("deepseek", "https://example.test", "deepseek-flash")).toBe(compatPresets.deepseek);
    expect(resolveCompat("openai", "https://api.deepseek.com", "deepseek-flash")).toBe(compatPresets.openai);
  });
  it("an unknown name gives nothing", () => {
    expect(resolveCompat("nope", "https://x.test", "m")).toBeUndefined();
  });
});
