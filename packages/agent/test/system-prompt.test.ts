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

describe("system prompt: where the tools run", () => {
  const tools = [{ name: "bash", description: "Run a command.", parameters: {}, effect: "exec" as const, execute: async () => ({ content: [] }) }];

  it("an environment that describes itself takes the place of the platform line", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work", platform: "darwin", description: "a remote machine (box). Commands go over SSH." });
    expect(prompt).toContain("Where your tools run: a remote machine (box). Commands go over SSH.");
    expect(prompt).not.toContain("Platform:");
    expect(prompt).not.toContain("darwin");
    expect(prompt).toContain("Working directory: /work");
  });

  it("without a description nothing changes", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work", platform: "darwin" });
    expect(prompt).toContain("Working directory: /work\nPlatform: darwin");
    expect(prompt).not.toContain("Where your tools run");
  });

  it("the description is in the <environment> section, after the rules", () => {
    const prompt = buildSystemPrompt({ tools, cwd: "/work", platform: "darwin", description: "elsewhere" });
    expect(prompt.indexOf("<rules>")).toBeLessThan(prompt.indexOf("<environment>"));
    expect(prompt.slice(prompt.indexOf("<environment>"))).toContain("Where your tools run: elsewhere");
  });
});

describe("system prompt: tools and rules that are not built in", () => {
  const custom = { name: "project_status", description: "Return the status. Takes no arguments.", parameters: {}, effect: "read" as const, execute: async () => ({ content: [] }) };
  it("lists a tool you wrote and adds no tool rule for it", () => {
    const prompt = buildSystemPrompt({ tools: [custom], cwd: "/work", platform: "darwin" });
    expect(prompt).toContain("- project_status: Return the status.");
    expect(prompt).not.toContain("Use read to examine files");
  });
  it("puts added rules after the built-in ones, once each", () => {
    const prompt = buildSystemPrompt({ tools: [], cwd: "/work", platform: "darwin", rules: ["Answer in French.", "Answer in French."] });
    expect(prompt.match(/- Answer in French\./g)).toHaveLength(1);
    expect(prompt.indexOf("Keep going until")).toBeLessThan(prompt.indexOf("Answer in French."));
  });
});
