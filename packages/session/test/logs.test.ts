import { mkdtemp, readFile, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createMemoryLog, openFileLog } from "../src/index.ts";
import { text, textOf } from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const seeds = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const userMessage = (value: string): { type: "message"; message: Message } => ({
  type: "message",
  message: { role: "user", content: text(value), ts: 1 },
});

describe("memory log", () => {
  for (const seed of seeds(30)) {
    it(`chains parents and projects in order (seed ${seed})`, async () => {
      let counter = 0;
      const log = createMemoryLog({ now: () => 5, newId: () => `id${++counter}` });
      const count = 1 + (seed % 12);
      for (let index = 0; index < count; index++) await log.append(userMessage(`m${index}`));
      const branch = await log.branch();
      expect(branch.map((item) => item.id)).toEqual(Array.from({ length: count }, (_, index) => `id${index + 1}`));
      expect(branch.map((item) => item.parentId)).toEqual([null, ...branch.slice(0, -1).map((item) => item.id)]);
      expect(branch.every((item) => item.ts === 5)).toBe(true);
      expect((await log.project()).map(textOf)).toEqual(Array.from({ length: count }, (_, index) => `m${index}`));
    });
  }

  it("returns copies, so callers cannot change the log", async () => {
    const log = createMemoryLog();
    await log.append(userMessage("a"));
    const first = (await log.branch()) as unknown[];
    first.length = 0;
    expect(await log.branch()).toHaveLength(1);
  });

  it("can start from entries loaded elsewhere", async () => {
    const source = createMemoryLog();
    await source.append(userMessage("a"));
    const resumed = createMemoryLog({ entries: await source.branch() });
    const added = await resumed.append(userMessage("b"));
    expect(added.parentId).toBe((await source.branch())[0]?.id);
  });
});

describe("file log: round trip", () => {
  for (const seed of seeds(40, 100)) {
    it(`reopening gives the same entries as a memory log (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const path = join(dir, `s${seed}.jsonl`);
      let counter = 0;
      const options = { now: () => 7, newId: () => `id${++counter}` };
      const file = await openFileLog(path, options);
      // the file log spends its first generated id on the header, so entry ids start at id2
      const memory = createMemoryLog({
        now: () => 7,
        newId: (() => {
          let c = 1;
          return () => `id${++c}`;
        })(),
      });
      const count = rng.int(0, 15);
      for (let index = 0; index < count; index++) {
        const body = userMessage(`line ${rng.int(0, 9999)}   "quoted" \n newline`);
        await file.append(body);
        await memory.append(body);
      }
      await file.close();
      const reopened = await openFileLog(path, options);
      expect(await reopened.branch()).toEqual(await memory.branch());
      expect(await reopened.project()).toEqual(await memory.project());
      await reopened.close();
    });
  }

  it("writes a header line first and one line per entry", async () => {
    const path = join(dir, "a.jsonl");
    const log = await openFileLog(path, { cwd: "/work" });
    await log.append(userMessage("x"));
    await log.close();
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ type: "header", version: 1, cwd: "/work" });
  });

  it("keeps new entries chained to the old ones after reopening", async () => {
    const path = join(dir, "b.jsonl");
    const first = await openFileLog(path);
    const a = await first.append(userMessage("a"));
    await first.close();
    const second = await openFileLog(path);
    const b = await second.append(userMessage("b"));
    expect(b.parentId).toBe(a.id);
    await second.close();
  });
});

describe("file log: torn writes", () => {
  const sample = JSON.stringify({ id: "zz", parentId: null, ts: 1, ...userMessage("partial") });
  for (let cut = 1; cut < sample.length; cut += Math.ceil(sample.length / 30)) {
    it(`discards a last line cut after ${cut} characters`, async () => {
      const path = join(dir, `torn${cut}.jsonl`);
      const log = await openFileLog(path);
      await log.append(userMessage("kept"));
      await log.close();
      const before = await readFile(path, "utf8");
      await writeFile(path, before + sample.slice(0, cut));
      const reopened = await openFileLog(path);
      expect((await reopened.project()).map(textOf)).toEqual(["kept"]);
      await reopened.close();
      expect(await readFile(path, "utf8")).toBe(before);
    });
  }

  it("also repairs a header-only file cut inside the first entry", async () => {
    const path = join(dir, "c.jsonl");
    const log = await openFileLog(path);
    await log.close();
    const before = await readFile(path, "utf8");
    await writeFile(path, `${before}{"id":"x`);
    await truncate(path, before.length + 3);
    const reopened = await openFileLog(path);
    expect(await reopened.branch()).toEqual([]);
    await reopened.close();
  });
});

describe("file log: refusals", () => {
  it("refuses a second open of the same session", async () => {
    const path = join(dir, "lock.jsonl");
    const first = await openFileLog(path);
    await expect(openFileLog(path)).rejects.toThrow("already open");
    await first.close();
    await expect(openFileLog(path).then((log) => log.close())).resolves.toBeUndefined();
  });

  it("takes over a lock left by a process that no longer exists", async () => {
    const path = join(dir, "stale.jsonl");
    await writeFile(`${path}.lock`, "2147483646");
    const log = await openFileLog(path);
    await log.close();
  });

  const corrupt: Array<[string, string, string]> = [
    ["invalid JSON in the middle", '{"type":"header","version":1,"id":"a","cwd":"/","ts":1}\nnot json\n{"id":"b"}\n', "line 2"],
    ["a first line that is not a header", '{"id":"a"}\n', "not a header"],
    ["a newer format version", '{"type":"header","version":99,"id":"a","cwd":"/","ts":1}\n', "newer"],
  ];
  for (const [name, content, message] of corrupt) {
    for (const variant of [0, 1, 2]) {
      it(`rejects ${name} (variant ${variant})`, async () => {
        const path = join(dir, `bad${variant}.jsonl`);
        await writeFile(path, content + (variant === 2 ? "" : ""));
        await expect(openFileLog(path)).rejects.toThrow(message);
        // a rejected open must not leave the lock behind
        await expect(readFile(`${path}.lock`)).rejects.toThrow();
      });
    }
  }

  it("treats an empty file as a new session", async () => {
    const path = join(dir, "empty.jsonl");
    await writeFile(path, "");
    const log = await openFileLog(path);
    expect(log.header.version).toBe(1);
    await log.close();
  });
});

describe("opening a session file that is not a session", () => {
  it("a directory cannot be opened as a session file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-dir-"));
    await expect(openFileLog(dir, { cwd: "/w" })).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
  it("a file with only blank lines is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-blank-"));
    const file = join(dir, "blank.jsonl");
    await writeFile(file, "\n\n");
    await expect(openFileLog(file, { cwd: "/w" })).rejects.toThrow(/not valid JSON/);
    await rm(dir, { recursive: true, force: true });
  });
});
