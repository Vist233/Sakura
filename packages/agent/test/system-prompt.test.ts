import { describe, expect, it } from "vitest";
import { builtinTools } from "@sakura/plugin-tools";
import { buildSystemPrompt } from "../src/index.ts";

const names = ["read", "write", "edit", "bash"] as const;
const subsets = Array.from({ length: 16 }, (_, mask) => names.filter((_, index) => mask & (1 << index)));
const build = (subset: readonly (typeof names)[number][], rules?: string[]) =>
  buildSystemPrompt({ tools: builtinTools([...subset]), cwd: "/work/project", platform: "darwin", ...(rules ? { rules } : {}) });

describe("system prompt", () => {
  for (const subset of subsets) {
    const label = subset.length ? subset.join("+") : "no tools";
    it(`lists exactly the available tools (${label})`, () => {
      const prompt = build(subset);
      for (const name of names) expect(prompt.includes(`- ${name}: `)).toBe(subset.includes(name));
      expect(prompt.includes("<tools>")).toBe(subset.length > 0);
    });

    it(`includes tool rules only for available tools (${label})`, () => {
      const prompt = build(subset);
      expect(prompt.includes("Use read to examine files")).toBe(subset.includes("read"));
      expect(prompt.includes("Use write only for new files")).toBe(subset.includes("write"));
      expect(prompt.includes("Use edit for precise changes")).toBe(subset.includes("edit"));
      expect(prompt.includes("prefer rg")).toBe(subset.includes("bash"));
    });

    it(`always has the preamble, general rules and environment (${label})`, () => {
      const prompt = build(subset);
      expect(prompt.startsWith("You are a coding agent.")).toBe(true);
      expect(prompt).toContain("Keep going until the user's request is completely resolved");
      expect(prompt).toContain("Working directory: /work/project");
      expect(prompt).toContain("Platform: darwin");
    });

    it(`has sections in a stable order (${label})`, () => {
      const prompt = build(subset);
      const order = ["<tools>", "<rules>", "<environment>"].map((tag) => prompt.indexOf(tag)).filter((index) => index >= 0);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  }

  it("adds extra rules from plugins without duplicates", () => {
    const prompt = build(["read"], ["Extra rule one.", "Extra rule one.", "Extra rule two."]);
    expect(prompt.match(/Extra rule one\./g)).toHaveLength(1);
    expect(prompt).toContain("Extra rule two.");
  });
  it("is deterministic", () => {
    expect(build(["read", "edit"])).toBe(build(["read", "edit"]));
  });
  it("never mentions sandbox or redaction when those plugins are absent", () => {
    const prompt = build([...names]);
    expect(prompt.toLowerCase()).not.toContain("sandbox");
    expect(prompt.toLowerCase()).not.toContain("redact");
  });
  it("uses the first sentence of each tool description as its one-line summary", () => {
    const line = build(["read"])
      .split("\n")
      .find((entry) => entry.startsWith("- read: "))!;
    expect(line).toBe("- read: Read the contents of a file.");
  });
});
