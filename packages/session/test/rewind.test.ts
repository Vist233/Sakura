import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createMemoryLog, openFileLog } from "../src/index.ts";
import { text, textOf } from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rewind-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const say = (value: string): { type: "message"; message: Message } => ({ type: "message", message: { role: "user", content: text(value), ts: 1 } });

describe("rewinding a memory log", () => {
  it("appends after a rewind branch off the chosen entry", async () => {
    const log = createMemoryLog();
    const a = await log.append(say("a"));
    const b = await log.append(say("b"));
    await log.append(say("c"));
    log.rewindTo(a.id);
    const d = await log.append(say("d"));
    expect(d.parentId).toBe(a.id);
    expect((await log.project()).map(textOf)).toEqual(["a", "d"]);
    expect(b.id).not.toBe(d.id);
  });

  it("the old branch is kept and can be returned to", async () => {
    const log = createMemoryLog();
    await log.append(say("a"));
    const b = await log.append(say("b"));
    const c = await log.append(say("c"));
    log.rewindTo(b.id);
    await log.append(say("x"));
    expect((await log.project()).map(textOf)).toEqual(["a", "b", "x"]);
    log.rewindTo(c.id);
    expect((await log.project()).map(textOf)).toEqual(["a", "b", "c"]);
  });

  it("rewinding to the leaf changes nothing", async () => {
    const log = createMemoryLog();
    await log.append(say("a"));
    const b = await log.append(say("b"));
    log.rewindTo(b.id);
    expect((await log.branch()).map((entry) => entry.id)).toContain(b.id);
    expect((await log.project()).map(textOf)).toEqual(["a", "b"]);
  });

  it("rejects an id that is not in the log", async () => {
    const log = createMemoryLog();
    await log.append(say("a"));
    expect(() => log.rewindTo("nope")).toThrow("no entry");
  });

  it("can rewind to the very beginning (before the first entry)", async () => {
    const log = createMemoryLog();
    await log.append(say("a"));
    log.rewindTo(null);
    const root = await log.append(say("fresh"));
    expect(root.parentId).toBeNull();
    expect((await log.project()).map(textOf)).toEqual(["fresh"]);
  });

  it("reports the current leaf", async () => {
    const log = createMemoryLog();
    expect(log.leaf()).toBeNull();
    const a = await log.append(say("a"));
    expect(log.leaf()).toBe(a.id);
    log.rewindTo(null);
    expect(log.leaf()).toBeNull();
  });

  for (const seed of range(40)) {
    it(`matches a tree model under random appends and rewinds (seed ${seed})`, async () => {
      const rng = createRng(seed);
      let counter = 0;
      const log = createMemoryLog({ newId: () => `n${++counter}` });
      const parent = new Map<string, string | null>();
      let leaf: string | null = null;
      const ids: string[] = [];
      for (let step = 0; step < rng.int(5, 40); step++) {
        if (ids.length > 0 && rng.chance(0.3)) {
          leaf = rng.chance(0.15) ? null : rng.pick(ids);
          log.rewindTo(leaf);
        } else {
          const entry = await log.append(say(`m${step}`));
          parent.set(entry.id, leaf);
          expect(entry.parentId).toBe(leaf);
          leaf = entry.id;
          ids.push(entry.id);
        }
        const expected: string[] = [];
        for (let at = leaf; at !== null; at = parent.get(at) ?? null) expected.unshift(at);
        expect((await log.branch()).map((entry) => entry.id)).toEqual(expected);
      }
    });
  }
});

describe("rewinding a file log", () => {
  it("keeps every branch in the file and restores the last one on reopening", async () => {
    const path = join(dir, "s.jsonl");
    const log = await openFileLog(path);
    await log.append(say("a"));
    const b = await log.append(say("b"));
    await log.append(say("c"));
    log.rewindTo(b.id);
    await log.append(say("x"));
    await log.close();
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1 + 4);
    const reopened = await openFileLog(path);
    expect((await reopened.project()).map(textOf)).toEqual(["a", "b", "x"]);
    await reopened.close();
  });

  it("appends after reopening continue from the last entry written", async () => {
    const path = join(dir, "s2.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("a"));
    log.rewindTo(null);
    const z = await log.append(say("z"));
    await log.close();
    const reopened = await openFileLog(path);
    const next = await reopened.append(say("n"));
    expect(next.parentId).toBe(z.id);
    expect(a.id).not.toBe(z.id);
    await reopened.close();
  });
});
