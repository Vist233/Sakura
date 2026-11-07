import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import type { ThinkingLevel } from "@sakura/kernel";
import { compatPresets } from "../src/index.ts";
import { thinkingParameters } from "../src/chat/compat.ts";
import { isRetryable } from "../src/chat/errors.ts";

const base = compatPresets.deepseek as Parameters<typeof thinkingParameters>[0];
const withFormat = (thinkingFormat: "none" | "openai" | "deepseek") => ({ ...base, thinkingFormat }) as Parameters<typeof thinkingParameters>[0];
const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];

describe("thinkingParameters", () => {
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
