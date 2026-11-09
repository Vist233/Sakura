import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEnvironment, OutsideDirectoryError } from "../src/index.ts";

// `confine: true` is a promise about the file operations of an environment: nothing outside the working directory is read, written, listed or
// used as the directory of a command, whatever the path looks like (absolute, with .., through a link). It is not a sandbox for a shell.
let base: string;
let work: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "confine-"));
  work = join(base, "work");
  outside = join(base, "outside");
  await mkdir(work);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  await writeFile(join(work, "inside.txt"), "inside");
  await mkdir(join(base, "work-evil"));
  await writeFile(join(base, "work-evil", "x.txt"), "evil");
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("a confined local environment", () => {
  it("works as usual inside the working directory, including new files in new folders", async () => {
    const env = createLocalEnvironment(work, { confine: true });
    expect(new TextDecoder().decode(await env.readFile("inside.txt"))).toBe("inside");
    await env.writeFile("a/b/new.txt", "new");
    expect(await readFile(join(work, "a/b/new.txt"), "utf8")).toBe("new");
    expect(await env.list(".")).toContain("inside.txt");
    expect((await env.stat("inside.txt"))?.size).toBe(6);
    expect((await env.exec("pwd", {})).output.trim()).toContain("work");
    expect(env.resolve(".")).toBe(env.cwd);
  });

  const escapes: Array<[string, string]> = [
    ["an absolute path", "outside/secret.txt"],
    ["a path with ..", "../outside/secret.txt"],
    ["a sibling folder whose name starts like the working directory", "work-evil/x.txt"],
    ["the parent folder", ".."],
  ];
  for (const [label, relative] of escapes) {
    it(`refuses ${label}: read, write, stat and list`, async () => {
      const env = createLocalEnvironment(work, { confine: true });
      const path = label === "an absolute path" ? join(base, relative) : label.startsWith("a sibling") ? join(base, relative) : relative;
      await expect(env.readFile(path)).rejects.toBeInstanceOf(OutsideDirectoryError);
      await expect(env.writeFile(path, "x")).rejects.toBeInstanceOf(OutsideDirectoryError);
      await expect(env.stat(path)).rejects.toBeInstanceOf(OutsideDirectoryError);
      await expect(env.list(path)).rejects.toBeInstanceOf(OutsideDirectoryError);
      expect(() => env.resolve(path)).toThrow(OutsideDirectoryError);
    });
  }

  it("refuses a link inside the working directory that points outside, for reading and for writing", async () => {
    await symlink(outside, join(work, "link"));
    await symlink(join(outside, "secret.txt"), join(work, "file-link"));
    const env = createLocalEnvironment(work, { confine: true });
    await expect(env.readFile("link/secret.txt")).rejects.toBeInstanceOf(OutsideDirectoryError);
    await expect(env.readFile("file-link")).rejects.toBeInstanceOf(OutsideDirectoryError);
    await expect(env.writeFile("link/planted.txt", "x")).rejects.toBeInstanceOf(OutsideDirectoryError);
    await expect(env.writeFile("link/deeper/planted.txt", "x")).rejects.toBeInstanceOf(OutsideDirectoryError);
    expect(await env.stat("inside.txt")).toBeDefined();
    await expect(readFile(join(outside, "planted.txt"))).rejects.toThrow(); // nothing was written
  });

  it("refuses a directory for a command that is outside, and allows one inside", async () => {
    const env = createLocalEnvironment(work, { confine: true });
    await mkdir(join(work, "sub"));
    expect((await env.exec("pwd", { cwd: "sub" })).output.trim()).toContain("sub");
    await expect(env.exec("pwd", { cwd: outside })).rejects.toBeInstanceOf(OutsideDirectoryError);
    expect(() => env.spawn("pwd", { cwd: ".." })).toThrow(OutsideDirectoryError);
  });

  it("lets the model read the output file of a command it started, because the bash tool tells it to, but not write there", async () => {
    const env = createLocalEnvironment(work, { confine: true });
    const handle = env.spawn("echo started; sleep 0.2; echo finished", {});
    await handle.wait();
    expect(handle.outputFile).not.toContain(work);
    expect(new TextDecoder().decode(await env.readFile(handle.outputFile))).toContain("finished");
    expect(env.resolve(handle.outputFile)).toBe(handle.outputFile);
    await expect(env.writeFile(handle.outputFile, "tampered")).rejects.toBeInstanceOf(OutsideDirectoryError);
    await expect(env.readFile(join(handle.outputFile, "..", "..", "etc"))).rejects.toBeInstanceOf(OutsideDirectoryError);
  });

  it("says in words what it is, so the model does not waste turns", () => {
    const env = createLocalEnvironment(work, { confine: true });
    expect(env.description).toContain(env.cwd);
    expect(env.description).toMatch(/outside/);
  });

  it("is off by default: the plain environment still reaches everything", async () => {
    const env = createLocalEnvironment(work);
    expect(new TextDecoder().decode(await env.readFile(join(outside, "secret.txt")))).toBe("secret");
    expect(env.description).toBeUndefined();
  });
});
