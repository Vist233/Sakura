import type { Tool, ToolCall } from "@sakura/kernel";
import { describe, expect, it } from "vitest";
import { hardRules, mayLeaveDirectory } from "../src/hard-rules.ts";

// A read-only call that points outside the working directory (or cannot be read with certainty) is not waved through:
// it goes on to the next link, the reviewer, which weighs it against what the user asked for.

const readTool: Tool = { name: "read", description: "", parameters: {}, effect: "read", execute: async () => ({ content: [] }) };
const tools: Record<string, Tool> = { read: readTool };
const ask = async (call: ToolCall, cwd?: string) =>
  (await hardRules.review(call, { log: undefined as never, signal: new AbortController().signal, tool: (name) => tools[name], ...(cwd !== undefined ? { cwd } : {}) })).kind;
const bash = (command: string): ToolCall => ({ id: "c", name: "bash", args: { command } });
const WORK = "/home/me/project";

describe("mayLeaveDirectory", () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ["src/index.ts", WORK, false],
    ["./src/../lib/a.ts", WORK, false],
    ["..", WORK, true],
    ["../other/file", WORK, true],
    ["a/../../b", WORK, true],
    ["a/..b", WORK, false],
    ["a..b", WORK, false],
    [`${WORK}/src/a.ts`, WORK, false],
    [WORK, WORK, false],
    [`${WORK}/`, WORK, false],
    [`${WORK}-other/a`, WORK, true],
    ["/etc/hosts", WORK, true],
    ["/etc/hosts", undefined, true],
    ["~", WORK, true],
    ["~/notes", WORK, true],
    ["$HOME/notes", WORK, true],
    ["`pwd`/x", WORK, true],
    ["-n", WORK, false],
    ["-la", WORK, false],
    ["--file=../x", WORK, true],
    ["--file=src/x", WORK, false],
    ["--color=always", WORK, false],
    ["--path=/etc/passwd", WORK, true],
    ["", WORK, false],
  ];
  for (const [word, cwd, expected] of cases) {
    it(`${JSON.stringify(word)} with cwd ${cwd ?? "unknown"} -> ${expected ? "may leave" : "stays"}`, () => {
      expect(mayLeaveDirectory(word, cwd)).toBe(expected);
    });
  }
});

describe("hard rules: read-only commands that point outside the directory go to the reviewer", () => {
  const cases: Array<[string, "allow" | "pass"]> = [
    ["cat src/index.ts", "allow"],
    ["cat ../secret.txt", "pass"],
    ["cat ../../x", "pass"],
    ["ls ..", "pass"],
    ["cd .. && ls", "pass"],
    ["ls /etc", "pass"],
    ["cat /home/me/project/src/a.ts", "allow"],
    ["cat ~/notes.txt", "pass"],
    ["cat $HOME/notes.txt", "pass"],
    ["grep -r todo .", "allow"],
    ["grep -r todo ..", "pass"],
    ["git -C ../other log", "pass"],
    ["git log", "allow"],
    ["head -n 5 src/a.ts | wc -l", "allow"],
    ["head -n 5 ../a.ts | wc -l", "pass"],
    ["find . -name '*.ts'", "allow"],
    ["find / -name '*.ts'", "pass"],
    ["echo hello", "allow"],
  ];
  for (const [command, expected] of cases) {
    it(`${command} -> ${expected}`, async () => {
      expect(await ask(bash(command), WORK)).toBe(expected);
    });
  }

  it("without a known working directory any absolute path goes to the reviewer", async () => {
    expect(await ask(bash("cat /home/me/project/a.ts"))).toBe("pass");
    expect(await ask(bash("cat a.ts"))).toBe("allow");
  });

  it("a command that is already refused stays refused", async () => {
    expect((await hardRules.review(bash("rm -rf /"), { log: undefined as never, signal: new AbortController().signal, tool: () => undefined, cwd: WORK })).kind).toBe("deny");
  });
});

describe("hard rules: a read tool that points outside the directory goes to the reviewer", () => {
  const read = (path: string): ToolCall => ({ id: "c", name: "read", args: { path } });
  it("inside stays allowed", async () => {
    expect(await ask(read("src/a.ts"), WORK)).toBe("allow");
    expect(await ask(read(`${WORK}/src/a.ts`), WORK)).toBe("allow");
  });
  it("outside goes on", async () => {
    expect(await ask(read("../a.ts"), WORK)).toBe("pass");
    expect(await ask(read("/etc/hosts"), WORK)).toBe("pass");
  });
});
