import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { bashTool } from "../src/builtin/bash.ts";
import { builtinTools } from "../src/index.ts";
import { range, run, useSandbox } from "./helpers.ts";

const box = useSandbox();

describe("bash", () => {
  for (const seed of range(30)) {
    it(`returns output of a successful command (seed ${seed})`, async () => {
      const word = `out${createRng(seed).int(0, 99999)}`;
      const result = await run(bashTool, box.env, { command: `echo ${word}` });
      expect(result.isError).toBeUndefined();
      expect(result.text.trim()).toBe(word);
    });
  }

  for (const code of [1, 2, 5, 42, 127]) {
    it(`a failing command (exit ${code}) is an error result that shows the code`, async () => {
      const result = await run(bashTool, box.env, { command: `echo before; exit ${code}` });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("before");
      expect(result.text).toContain(`exited with code ${code}`);
    });
  }

  it("says so when there is no output", async () => {
    expect((await run(bashTool, box.env, { command: "true" })).text).toBe("(no output)");
  });
  it("includes stderr", async () => {
    expect((await run(bashTool, box.env, { command: "echo oops 1>&2" })).text).toContain("oops");
  });
  it("runs in the environment's directory", async () => {
    await box.env.writeFile("here.txt", "x");
    expect((await run(bashTool, box.env, { command: "ls" })).text).toContain("here.txt");
  });

  for (const variant of range(5, 100)) {
    it(`a timeout kills the command and says so (variant ${variant})`, async () => {
      const started = Date.now();
      const result = await run(bashTool, box.env, { command: "echo started; sleep 30", timeout: 0.2 + variant / 100 });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("timed out");
      expect(result.text).toContain("started");
      expect(Date.now() - started).toBeLessThan(5000);
    });
  }

  it("keeps the end of a long output and says it was cut", async () => {
    const result = await run(bashTool, box.env, { command: "seq 1 5000" });
    expect(result.text).toContain("Output truncated");
    expect(result.text).toContain("5000");
    expect(result.text).not.toContain("\n1\n");
  });
  it("is stopped by the abort signal", async () => {
    const controller = new AbortController();
    const pending = run(bashTool, box.env, { command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect((await pending).isError).toBe(true);
  });

  const bad: Array<[string, unknown]> = [
    ["no command", {}],
    ["command not a string", { command: 5 }],
    ["timeout zero", { command: "true", timeout: 0 }],
    ["timeout negative", { command: "true", timeout: -1 }],
    ["timeout a string", { command: "true", timeout: "5" }],
  ];
  for (const [name, args] of bad) {
    it(`rejects ${name}`, async () => {
      expect((await run(bashTool, box.env, args)).isError).toBe(true);
    });
  }

  it("must not be replayed and is not read-only", () => {
    expect(bashTool.replay).toBe("never");
    expect(bashTool.effect).toBe("exec");
  });
});

describe("builtinTools", () => {
  it("lists read, write, edit and bash by default", () => {
    expect(builtinTools().map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
  });
  it("can select a subset", () => {
    expect(builtinTools(["read"]).map((tool) => tool.name)).toEqual(["read"]);
  });
  it("every tool has an object schema with required fields listed", () => {
    for (const tool of builtinTools()) {
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(Array.isArray((tool.parameters as { required?: unknown }).required)).toBe(true);
    }
  });
});
