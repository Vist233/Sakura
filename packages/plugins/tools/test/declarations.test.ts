// What the model is shown about the built-in tools, and the exact answers of the simple paths. See toolset/test/declarations.test.ts for why.
import { describe, expect, it } from "vitest";
import { writeTool } from "../src/builtin/write.ts";
import { run, useSandbox } from "./helpers.ts";

const box = useSandbox();
const { execute: _execute, ...declaration } = writeTool;

describe("write", () => {
  it("is declared like this", () => {
    expect(declaration).toEqual({
      name: "write",
      description:
        "Write content to a file. Creates the file and any missing parent directories, or overwrites an existing file completely. " +
        "Use it only for new files or complete rewrites; for changes to an existing file use edit. Keep each file under about 2000 lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the file to write (relative or absolute)" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
      effect: "write",
    });
  });

  it("reports the number of bytes, not characters", async () => {
    const result = await run(writeTool, box.env, { path: "a.txt", content: "é好" });
    expect(result.content).toEqual([{ type: "text", text: "Successfully wrote 5 bytes to a.txt" }]);
    expect("isError" in result).toBe(false);
  });

  it("refuses a directory and says which", async () => {
    await box.env.writeFile("d/x.txt", "x");
    const result = await run(writeTool, box.env, { path: "d", content: "x" });
    expect(result.content).toEqual([{ type: "text", text: "d is a directory." }]);
    expect(result.isError).toBe(true);
  });

  it("a missing argument is an error result naming it", async () => {
    const result = await run(writeTool, box.env, { path: "a.txt" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("content");
  });

  it("any other failure becomes an error result with its message", async () => {
    const broken = { ...box.env, writeFile: async () => Promise.reject(new Error("disk full")) };
    const result = await run(writeTool, broken, { path: "a.txt", content: "x" });
    expect(result.content).toEqual([{ type: "text", text: "disk full" }]);
    expect(result.isError).toBe(true);
  });

  it("a failure that is not an Error is still reported", async () => {
    const broken = { ...box.env, writeFile: async () => Promise.reject("plain string") };
    expect((await run(writeTool, broken, { path: "a.txt", content: "x" })).text).toBe("plain string");
  });
});

import { readTool } from "../src/builtin/read.ts";
import { editTool } from "../src/builtin/edit.ts";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
const failure = (text: string) => ({ content: [{ type: "text", text }], isError: true });

describe("read: what is said besides the file", () => {
  it("a directory", async () => {
    await box.env.writeFile("d/x.txt", "x");
    const result = await run(readTool, box.env, { path: "d" });
    expect(result.content).toEqual(failure("d is a directory, not a file.").content);
    expect(result.isError).toBe(true);
  });

  it("an image is announced with its type and the path is kept for the model client", async () => {
    await box.env.writeFile("pic.PNG", "not really a png");
    const result = await run(readTool, box.env, { path: "pic.PNG" });
    expect(result.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", mediaType: "image/png", ref: box.env.resolve("pic.PNG") },
    ]);
  });

  it("with a limit that stops before the end, it says how many lines are left and where to go on", async () => {
    await box.env.writeFile("f.txt", lines(10));
    const result = await run(readTool, box.env, { path: "f.txt", offset: 2, limit: 3 });
    expect(result.text).toBe("line 2\nline 3\nline 4\n\n[6 more lines in file. Use offset=5 to continue.]");
  });

  it("a limit that ends exactly at the end of the file adds nothing", async () => {
    await box.env.writeFile("f.txt", lines(10));
    expect((await run(readTool, box.env, { path: "f.txt", offset: 8, limit: 3 })).text).toBe("line 8\nline 9\nline 10");
    expect((await run(readTool, box.env, { path: "f.txt", limit: 10 })).text).toBe(lines(10));
  });

  it("a file longer than the default cut says which lines were shown", async () => {
    await box.env.writeFile("long.txt", lines(2500));
    const result = await run(readTool, box.env, { path: "long.txt", offset: 11 });
    expect(result.text.endsWith("\n\n[Showing lines 11-2010 of 2500. Use offset=2011 to continue.]")).toBe(true);
    expect(result.text.startsWith("line 11\nline 12\n")).toBe(true);
  });

  it("an empty file is empty, and so is a lone newline", async () => {
    await box.env.writeFile("empty.txt", "");
    await box.env.writeFile("nl.txt", "\n");
    expect((await run(readTool, box.env, { path: "empty.txt" })).content).toEqual([{ type: "text", text: "" }]);
    expect((await run(readTool, box.env, { path: "nl.txt" })).content).toEqual([{ type: "text", text: "" }]);
  });

  it("the newline that ends the file does not make an extra line", async () => {
    await box.env.writeFile("f.txt", "a\nb\n");
    expect((await run(readTool, box.env, { path: "f.txt", offset: 3 })).text).toBe("Offset 3 is beyond the end of the file (2 lines in total).");
    expect((await run(readTool, box.env, { path: "f.txt", offset: 2, limit: 1 })).text).toBe("b");
  });

  it("an offset past the end says how long the file is", async () => {
    await box.env.writeFile("f.txt", lines(3));
    const result = await run(readTool, box.env, { path: "f.txt", offset: 4 });
    expect(result.content).toEqual(failure("Offset 4 is beyond the end of the file (3 lines in total).").content);
    expect(result.isError).toBe(true);
  });

  it("a missing argument is an error result", async () => {
    const result = await run(readTool, box.env, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("path");
  });
});

describe("edit: malformed input and directories", () => {
  it("an entry that is not an object, or lacks a text, is named by its position", async () => {
    await box.env.writeFile("f.txt", "abc");
    for (const edits of [[null], [{ oldText: "a" }], [{ newText: "a" }], [{ oldText: 1, newText: "a" }], [{ oldText: "a", newText: "x" }, { oldText: "b" }]]) {
      const result = await run(editTool, box.env, { path: "f.txt", edits });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^edits\[\d\] must have string oldText and newText\.$/);
    }
    expect((await run(editTool, box.env, { path: "f.txt", edits: [{ oldText: "a", newText: "x" }, { oldText: "b" }] })).text).toBe("edits[1] must have string oldText and newText.");
  });

  it("the old single-edit form works, alone or together with edits[]", async () => {
    await box.env.writeFile("f.txt", "abc");
    expect((await run(editTool, box.env, { path: "f.txt", oldText: "a", newText: "X" })).isError).toBeUndefined();
    expect((await run(editTool, box.env, { path: "f.txt", edits: [{ oldText: "b", newText: "Y" }], oldText: "c", newText: "Z" })).isError).toBeUndefined();
    expect(decodeURIComponent(encodeURIComponent(new TextDecoder().decode(await box.env.readFile("f.txt"))))).toBe("XYZ");
  });

  it("only one half of the old form is not an edit", async () => {
    await box.env.writeFile("f.txt", "abc");
    for (const half of [{ oldText: "a" }, { newText: "a" }]) {
      const result = await run(editTool, box.env, { path: "f.txt", ...half });
      expect(result.text).toBe("Provide at least one edit in edits[].");
    }
  });

  it("a directory is refused and named", async () => {
    await box.env.writeFile("d/x.txt", "x");
    const result = await run(editTool, box.env, { path: "d", edits: [{ oldText: "a", newText: "b" }] });
    expect(result.text).toBe("d is a directory.");
    expect(result.isError).toBe(true);
  });

  it("is declared with these parameters", () => {
    const { execute: _execute, ...declaration } = editTool;
    expect(declaration.name).toBe("edit");
    expect(declaration.effect).toBe("write");
    expect(declaration.parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string", description: "Replacement text." } }, required: ["oldText", "newText"] },
        },
      },
      required: ["path", "edits"],
    });
  });
});

import { createBashTool, softLimitFor } from "../src/builtin/bash.ts";

describe("bash: declaration and the wording of what it reports", () => {
  it("is declared like this", () => {
    const { execute: _execute, ...declaration } = createBashTool();
    expect(declaration.name).toBe("bash");
    expect(declaration.effect).toBe("exec");
    expect(declaration.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        timeout: { type: "number", description: "Kill the command after this many seconds" },
        background: { type: "boolean", description: "Start the command and return at once, without waiting for it to end" },
        wake: { type: "boolean", description: "For a command that runs in the background: wake you up when it ends (true), or not (false)" },
      },
      required: ["command"],
    });
    expect(declaration.description).toContain("moved to the background");
    expect(declaration.description).toContain("there is no default timeout");
  });

  it("softLimitFor adds the seconds of a leading sleep, fractions included, and only at the start", () => {
    expect(softLimitFor("echo hi", 1000)).toBe(1000);
    expect(softLimitFor("sleep 30", 1000)).toBe(31_000);
    expect(softLimitFor("  sleep 2.5 && true", 1000)).toBe(3500);
    expect(softLimitFor("sleep30", 1000)).toBe(1000);
    expect(softLimitFor("true; sleep 30", 1000)).toBe(1000);
  });

  it("a failing command reports its exit code after the output", async () => {
    const result = await run(createBashTool(), box.env, { command: "echo out; exit 3" });
    expect(result.text).toBe("out\n\nCommand exited with code 3.");
    expect(result.isError).toBe(true);
  });

  it("a command with no output says so", async () => {
    expect((await run(createBashTool(), box.env, { command: "true" })).content).toEqual([{ type: "text", text: "(no output)" }]);
  });

  it("a command stopped by its timeout says how long it was given", async () => {
    const result = await run(createBashTool(), box.env, { command: "echo started; sleep 5", timeout: 0.3 });
    expect(result.text).toBe("started\n\nCommand timed out after 0.3 seconds.");
    expect(result.isError).toBe(true);
  });

  it("a command that moves to the background says after how many seconds, where the output goes and how to stop it", async () => {
    const result = await run(createBashTool({ softTimeoutMs: 1000 }), box.env, { command: "echo early; sleep 5" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^The command was still running after 1 seconds, so it was moved to the background\.\npid: \d+\nOutput is being written to: \S+\n/);
    expect(result.text).toMatch(/to stop it run `kill -- -\d+`\.\n\nOutput so far \(last lines\):\nearly$/);
  });

  it("a background command that has printed nothing yet has no 'output so far' part", async () => {
    const result = await run(createBashTool({ softTimeoutMs: 1000 }), box.env, { command: "true; sleep 4" });
    expect(result.text.startsWith("The command was still running after 1 seconds")).toBe(true);
    expect(result.text).not.toContain("Output so far");
  });

  it("a missing command is an error result naming the argument", async () => {
    const result = await run(createBashTool(), box.env, {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("command");
  });
});

describe("bash: background: true", () => {
  const bash = (grace = 200) => createBashTool({ backgroundGraceMs: grace });
  const waitFor = async (check: () => boolean, ms = 5000) => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  };

  it("returns without waiting for the command, and says it was started in the background", async () => {
    const started = Date.now();
    const result = await run(bash(), box.env, { command: "sleep 4", background: true });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^The command was started in the background and is still running\.\npid: \d+\nOutput is being written to: \S+\nTo check progress/);
  });

  it("is told when the command ends, with its exit code and where the output is", async () => {
    const notices: string[] = [];
    const result = await run(bash(), box.env, { command: "echo hello; sleep 1; exit 4", background: true }, undefined, (text) => notices.push(text));
    const pid = /pid: (\d+)/.exec(result.text)![1];
    await waitFor(() => notices.length > 0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(new RegExp(`^The background command \\(pid ${pid}\\) finished with exit code 4\\. Its output is in \\S+\\.$`));
  });

  it("shows what the command has printed so far", async () => {
    const result = await run(bash(500), box.env, { command: "echo first line; sleep 4", background: true });
    expect(result.text).toMatch(/\n\nOutput so far \(last lines\):\nfirst line$/);
  });

  it("a command that fails at once is reported as a failure, not as started", async () => {
    const result = await run(bash(2000), box.env, { command: "echo oops; exit 3", background: true });
    expect(result.text).toBe("oops\n\nCommand exited with code 3.");
    expect(result.isError).toBe(true);
  });

  it("a command that ends at once and succeeds returns its output as usual", async () => {
    expect((await run(bash(2000), box.env, { command: "echo done", background: true })).text).toBe("done");
  });

  it("the timeout still applies to a command in the background", async () => {
    const notices: string[] = [];
    await run(bash(100), box.env, { command: "sleep 30", background: true, timeout: 0.5 }, undefined, (text) => notices.push(text));
    await waitFor(() => notices.length > 0);
    expect(notices[0]).toContain("was stopped by its timeout");
  });

  it("false and null mean the usual behaviour: wait for the command", async () => {
    for (const background of [false, null]) expect((await run(bash(50), box.env, { command: "sleep 0.3; echo waited", background })).text).toBe("waited");
  });

  it("anything else is an error that names the argument", async () => {
    for (const background of ["yes", 1, {}, []]) {
      const result = await run(bash(), box.env, { command: "true", background });
      expect(result.text).toBe("'background' must be true or false.");
      expect(result.isError).toBe(true);
    }
  });

  it("the sleep rule does not apply: a command that starts with sleep is not given extra time", async () => {
    const result = await run(bash(300), box.env, { command: "sleep 2", background: true });
    expect(result.text.startsWith("The command was started in the background")).toBe(true);
  });

  it("the default grace is one second", async () => {
    const started = Date.now();
    await run(createBashTool(), box.env, { command: "sleep 5", background: true });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(2500);
  });
});

describe("bash: the rest of the wording", () => {
  const waitFor = async (check: () => boolean, ms = 6000) => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  };

  it("softLimitFor reads the whole number, with all its decimals, after any amount of spaces", () => {
    expect(softLimitFor("sleep 2.25", 0)).toBe(2250);
    expect(softLimitFor("sleep    3", 0)).toBe(3000);
    expect(softLimitFor("\tsleep 1 && true", 100)).toBe(1100);
    expect(softLimitFor("sleep 12", 0)).toBe(12_000);
  });

  it("a command killed by a signal reports that there is no exit code", async () => {
    const result = await run(createBashTool(), box.env, { command: "echo before; kill -9 $$" });
    expect(result.text).toBe("before\n\nCommand exited with code unknown (killed).");
    expect(result.isError).toBe(true);
  });

  it("a background command that is killed is reported as stopped", async () => {
    const notices: string[] = [];
    await run(createBashTool({ backgroundGraceMs: 100 }), box.env, { command: "sleep 1; kill -9 $$", background: true }, undefined, (text) => notices.push(text));
    await waitFor(() => notices.length > 0);
    expect(notices[0]).toMatch(/^The background command \(pid \d+\) was stopped\. Its output is in \S+\.$/);
  });

  it("a command that cannot be started at all is an error result with the reason", async () => {
    const broken = {
      ...box.env,
      spawn: () => {
        throw new Error("no shell available");
      },
    };
    const result = await run(createBashTool(), broken as never, { command: "true" });
    expect(result).toMatchObject({ isError: true, text: "no shell available" });
    const plain = {
      ...box.env,
      spawn: () => {
        throw "plain failure";
      },
    };
    expect((await run(createBashTool(), plain as never, { command: "true" })).text).toBe("plain failure");
  });
});

describe("read: image types", () => {
  for (const [extension, mediaType] of [
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["bmp", "image/bmp"],
  ]) {
    it(`.${extension} is announced as ${mediaType}`, async () => {
      await box.env.writeFile(`pic.${extension}`, "x");
      const result = await run(readTool, box.env, { path: `pic.${extension}` });
      expect(result.content[0]).toEqual({ type: "text", text: `Read image file [${mediaType}]` });
      expect(result.content[1]).toMatchObject({ type: "image", mediaType });
    });
  }
  it("a file whose name only ends like an image is still text when the extension is something else", async () => {
    await box.env.writeFile("notes.png.txt", "plain");
    expect((await run(readTool, box.env, { path: "notes.png.txt" })).text).toBe("plain");
  });
});

describe("edit: what is said when edits cannot be applied", () => {
  const edit = (args: unknown) => run(editTool, box.env, args);

  it("an empty oldText is named, with its position when there are several edits", async () => {
    await box.env.writeFile("f.txt", "abc");
    expect((await edit({ path: "f.txt", edits: [{ oldText: "", newText: "x" }] })).text).toBe("oldText must not be empty in f.txt.");
    expect(
      (
        await edit({
          path: "f.txt",
          edits: [
            { oldText: "a", newText: "x" },
            { oldText: "", newText: "y" },
          ],
        })
      ).text,
    ).toBe("edits[1].oldText must not be empty in f.txt.");
  });

  it("a text that occurs more than once is refused, and the count and the position are given", async () => {
    await box.env.writeFile("f.txt", "same same other");
    const one = await edit({ path: "f.txt", edits: [{ oldText: "same", newText: "x" }] });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("Found 2 occurrences");
    const two = await edit({
      path: "f.txt",
      edits: [
        { oldText: "other", newText: "x" },
        { oldText: "same", newText: "y" },
      ],
    });
    expect(two.text).toContain("Found 2 occurrences of edits[1] in f.txt.");
  });

  it("a replacement that changes nothing is refused", async () => {
    await box.env.writeFile("f.txt", "abc");
    const one = await edit({ path: "f.txt", edits: [{ oldText: "abc", newText: "abc" }] });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("No changes made to f.txt.");
    const two = await edit({
      path: "f.txt",
      edits: [
        { oldText: "a", newText: "a" },
        { oldText: "b", newText: "b" },
      ],
    });
    expect(two.text).toContain("No changes made to f.txt. The replacements produced identical content.");
  });

  it("a file is left as it was when any one of its edits cannot be applied", async () => {
    await box.env.writeFile("f.txt", "one two three");
    const result = await edit({
      path: "f.txt",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "missing", newText: "x" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(new TextDecoder().decode(await box.env.readFile("f.txt"))).toBe("one two three");
  });
});
