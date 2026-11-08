// What a session log promises about what it holds, whether or not the disk behaves. Written from the promise, not from the code:
//   - an append either happened completely or not at all, and a log and its storage never disagree;
//   - one failed append does not make the next ones fail;
//   - appends keep the order they were made in;
//   - going back to an earlier entry is remembered, also when nothing is written afterwards.
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntryBody, LogEntry, Message } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createLog } from "../src/log-core.ts";
import type { Storage } from "../src/log-core.ts";
import { createMemoryLog, openFileLog } from "../src/index.ts";
import { createTree } from "../src/tree.ts";
import { text, textOf } from "./helpers.ts";

const say = (value: string): EntryBody => ({ type: "message", message: { role: "user", content: text(value), ts: 1 } satisfies Message });
const asRoot = process.getuid?.() === 0; // a root user can write to a file that was made read-only

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "durable-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A storage that records what it was given and fails when told to. */
function recording(shouldFail: (kind: "entry" | "rewind", number: number) => boolean = () => false) {
  const records: Array<{ kind: "entry"; entry: LogEntry } | { kind: "rewind"; to: string | null }> = [];
  let calls = 0;
  const storage: Storage = {
    async saveEntry(entry) {
      if (shouldFail("entry", ++calls)) throw new Error("disk refused");
      records.push({ kind: "entry", entry });
    },
    async saveRewind(to) {
      if (shouldFail("rewind", ++calls)) throw new Error("disk refused");
      records.push({ kind: "rewind", to });
    },
  };
  return { storage, records };
}
/** What a log opened from the stored records would hold. */
function replay(records: ReturnType<typeof recording>["records"]) {
  const tree = createTree([]);
  for (const record of records) {
    if (record.kind === "entry") tree.add(record.entry);
    else tree.moveLeaf(record.to);
  }
  return tree;
}

describe("an append is whole or not at all", () => {
  it("a refused append reports the failure, adds nothing and leaves the end where it was", async () => {
    const { storage, records } = recording((_kind, number) => number === 2);
    const log = createLog(createTree([]), storage);
    const first = await log.append(say("one"));
    await expect(log.append(say("two"))).rejects.toThrow("disk refused");
    expect((await log.branch()).map((entry) => entry.id)).toEqual([first.id]);
    expect(log.leaf()).toBe(first.id);
    expect(records).toHaveLength(1);
  });

  it("the next append after a refused one works and follows the last one that was kept", async () => {
    const { storage } = recording((_kind, number) => number === 2);
    const log = createLog(createTree([]), storage);
    const first = await log.append(say("one"));
    await log.append(say("two")).catch(() => undefined);
    const third = await log.append(say("three"));
    expect(third.parentId).toBe(first.id);
    expect((await log.project()).map(textOf)).toEqual(["one", "three"]);
  });

  it("a refusal in the middle of appends made at the same time spares the others, which keep their order", async () => {
    const { storage, records } = recording((_kind, number) => number === 3);
    const log = createLog(createTree([]), storage);
    const outcomes = await Promise.allSettled(["a", "b", "c", "d", "e"].map((value) => log.append(say(value))));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect((await log.project()).map(textOf)).toEqual(["a", "b", "d", "e"]);
    const kept = records.flatMap((record) => (record.kind === "entry" ? [record.entry] : []));
    for (let index = 1; index < kept.length; index++) expect(kept[index]!.parentId).toBe(kept[index - 1]!.id);
  });

  it("appends made at the same time form one chain in the order they were made", async () => {
    const log = createMemoryLog();
    await Promise.all(Array.from({ length: 60 }, (_, index) => log.append(say(String(index)))));
    expect((await log.project()).map(textOf)).toEqual(Array.from({ length: 60 }, (_, index) => String(index)));
  });

  for (const seed of Array.from({ length: 25 }, (_, index) => index + 1)) {
    it(`the log and its storage never disagree, whatever fails (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const { storage, records } = recording((kind) => kind === "entry" && rng.int(0, 99) < 30);
      const log = createLog(createTree([]), storage);
      const ids: string[] = [];
      for (let step = 0; step < 40; step++) {
        if (rng.int(0, 99) < 25 && ids.length > 0) {
          log.rewindTo(ids[rng.int(0, ids.length - 1)] ?? null);
        } else {
          const kept = await log.append(say(`m${step}`)).catch(() => undefined);
          if (kept) ids.push(kept.id);
        }
        await log.settled();
        const stored = replay(records);
        expect(stored.leaf()).toBe(log.leaf());
        expect(stored.branch().map((entry) => entry.id)).toEqual((await log.branch()).map((entry) => entry.id));
      }
    });
  }
});

describe.skipIf(asRoot)("a session file whose disk refuses a write", () => {
  it("works again as soon as the disk does, and the file and the log agree", async () => {
    const path = join(dir, "s.jsonl");
    const log = await openFileLog(path);
    await log.append(say("one"));
    await chmod(path, 0o444);
    await expect(log.append(say("two (refused)"))).rejects.toThrow();
    await chmod(path, 0o644);
    await log.append(say("three"));
    expect((await log.project()).map(textOf)).toEqual(["one", "three"]);
    await log.close();
    const reopened = await openFileLog(path);
    expect((await reopened.project()).map(textOf)).toEqual(["one", "three"]);
    await reopened.close();
  });

  it("a half line left by a failed write is cut off before the next one, so the file can still be opened", async () => {
    const path = join(dir, "t.jsonl");
    const log = await openFileLog(path);
    await log.append(say("one"));
    await chmod(path, 0o444);
    await log.append(say("refused")).catch(() => undefined);
    await chmod(path, 0o644);
    await appendFile(path, '{"type":"message","mess'); // what a write that failed half way would have left
    await log.append(say("after"));
    await log.close();
    const reopened = await openFileLog(path);
    expect((await reopened.project()).map(textOf)).toEqual(["one", "after"]);
    await reopened.close();
  });

  it("several refused appends in a row do not make it worse", async () => {
    const path = join(dir, "u.jsonl");
    const log = await openFileLog(path);
    await chmod(path, 0o444);
    for (let attempt = 0; attempt < 4; attempt++) await expect(log.append(say(`refused ${attempt}`))).rejects.toThrow();
    await chmod(path, 0o644);
    await log.append(say("fine"));
    await log.close();
    const reopened = await openFileLog(path);
    expect((await reopened.project()).map(textOf)).toEqual(["fine"]);
    await reopened.close();
  });
});

describe("going back is remembered", () => {
  async function reopen(path: string) {
    return openFileLog(path);
  }

  it("also when nothing is written afterwards", async () => {
    const path = join(dir, "a.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("A"));
    await log.append(say("B"));
    await log.append(say("C"));
    log.rewindTo(a.id);
    await log.close();
    const reopened = await reopen(path);
    expect(reopened.leaf()).toBe(a.id);
    expect((await reopened.project()).map(textOf)).toEqual(["A"]);
    await reopened.close();
  });

  it("to the very start", async () => {
    const path = join(dir, "b.jsonl");
    const log = await openFileLog(path);
    await log.append(say("A"));
    log.rewindTo(null);
    await log.close();
    const reopened = await reopen(path);
    expect(reopened.leaf()).toBeNull();
    expect(await reopened.project()).toEqual([]);
    await reopened.close();
  });

  it("an entry written after going back follows the place it went back to, and the record of going back no longer matters", async () => {
    const path = join(dir, "c.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("A"));
    await log.append(say("B"));
    log.rewindTo(a.id);
    const x = await log.append(say("X"));
    await log.close();
    const reopened = await reopen(path);
    expect(x.parentId).toBe(a.id);
    expect(reopened.leaf()).toBe(x.id);
    expect((await reopened.project()).map(textOf)).toEqual(["A", "X"]);
    await reopened.close();
  });

  it("going back again and again keeps only the last place", async () => {
    const path = join(dir, "d.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("A"));
    const b = await log.append(say("B"));
    await log.append(say("C"));
    log.rewindTo(b.id);
    log.rewindTo(a.id);
    log.rewindTo(b.id);
    await log.close();
    const reopened = await reopen(path);
    expect(reopened.leaf()).toBe(b.id);
    await reopened.close();
  });

  it("going back and forth to where it already is writes nothing", async () => {
    const path = join(dir, "e.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("A"));
    const before = await readFile(path, "utf8");
    log.rewindTo(a.id);
    await log.close();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("an unknown place is refused at once and writes nothing", async () => {
    const path = join(dir, "f.jsonl");
    const log = await openFileLog(path);
    await log.append(say("A"));
    const before = await readFile(path, "utf8");
    expect(() => log.rewindTo("no-such-entry")).toThrow("no entry");
    await log.close();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("closing waits for the record of going back to be written", async () => {
    const path = join(dir, "g.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("A"));
    await log.append(say("B"));
    log.rewindTo(a.id);
    await log.close(); // no await in between
    expect((await readFile(path, "utf8")).trim().split("\n").at(-1)).toBe(JSON.stringify({ type: "rewind", to: a.id }));
  });

  it("a record of going back to an entry that is not in the file is ignored, and the last entry stays the end", async () => {
    const path = join(dir, "h.jsonl");
    const log = await openFileLog(path);
    await log.append(say("A"));
    const b = await log.append(say("B"));
    await log.close();
    await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify({ type: "rewind", to: "gone" })}\n`);
    const reopened = await reopen(path);
    expect(reopened.leaf()).toBe(b.id);
    await reopened.close();
  });

  it("a half line after a record of going back is cut off as before and the rewind still holds", async () => {
    const path = join(dir, "i.jsonl");
    const log = await openFileLog(path);
    const a = await log.append(say("A"));
    await log.append(say("B"));
    log.rewindTo(a.id);
    await log.close();
    await appendFile(path, '{"type":"mess');
    const reopened = await reopen(path);
    expect(reopened.leaf()).toBe(a.id);
    await reopened.close();
  });

  it("a memory log behaves the same, without a file", async () => {
    const log = createMemoryLog();
    const a = await log.append(say("A"));
    await log.append(say("B"));
    log.rewindTo(a.id);
    expect(log.leaf()).toBe(a.id);
    const c = await log.append(say("C"));
    expect(c.parentId).toBe(a.id);
    expect((await log.project()).map(textOf)).toEqual(["A", "C"]);
  });
});
