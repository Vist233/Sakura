// Forking a session, written from what it promises: the new session holds the same conversation up to the point and does not cut a turn in two;
// the source is not changed; the two go on independently; and a file is never replaced.
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Content, EntryBody, LogEntry, Message } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createMemoryLog, forkLog, openFileLog } from "../src/index.ts";
import { text, textOf } from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fork-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const asRoot = process.getuid?.() === 0;

const message = (role: Message["role"], content: Content[], extra: Partial<Message> = {}): EntryBody => ({ type: "message", message: { role, content, ts: 1, ...extra } });
const say = (value: string) => message("user", text(value));
const reply = (value: string) => message("assistant", text(value));
const calls = (...ids: string[]) =>
  message(
    "assistant",
    ids.map((id) => ({ type: "tool_call" as const, id, name: "bash", args: { command: id } })),
  );
const result = (id: string, value = `result ${id}`) => message("tool", text(value), { toolCallId: id, toolName: "bash" });
const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const ids = (entries: readonly LogEntry[]) => entries.map((entry) => entry.id);

async function conversation() {
  const log = await openFileLog(join(dir, "source.jsonl"));
  const entries: LogEntry[] = [];
  for (const body of [say("q1"), reply("a1"), say("q2"), reply("a2"), say("q3")]) entries.push(await log.append(body));
  return { log, entries };
}

describe("forking: what the new session holds", () => {
  it("the conversation up to the point, as the model would have been shown it there", async () => {
    const { log, entries } = await conversation();
    await forkLog(log, join(dir, "fork.jsonl"), { upTo: entries[3]!.id });
    const fork = await openFileLog(join(dir, "fork.jsonl"));
    expect((await fork.project()).map(textOf)).toEqual(["q1", "a1", "q2", "a2"]);
    expect(fork.leaf()).toBe(entries[3]!.id);
    await fork.close();
    await log.close();
  });

  it("the same entries: same ids, same parents, same content", async () => {
    const { log, entries } = await conversation();
    await forkLog(log, join(dir, "fork.jsonl"), { upTo: entries[2]!.id });
    const stored = (await lines(join(dir, "fork.jsonl"))).slice(1);
    expect(stored).toEqual(entries.slice(0, 3));
    await log.close();
  });

  it("the whole current branch when no point is given", async () => {
    const { log, entries } = await conversation();
    await forkLog(log, join(dir, "fork.jsonl"));
    expect(ids((await lines(join(dir, "fork.jsonl"))).slice(1))).toEqual(ids(entries));
    await log.close();
  });

  it("a header of its own: another id, and where it came from", async () => {
    const { log, entries } = await conversation();
    const header = await forkLog(log, join(dir, "fork.jsonl"), { upTo: entries[1]!.id, sessionId: log.header.id, cwd: "/work/project" });
    expect(header.id).not.toBe(log.header.id);
    expect(header).toMatchObject({ type: "header", version: 1, cwd: "/work/project", forkedFrom: { entry: entries[1]!.id, session: log.header.id } });
    expect((await lines(join(dir, "fork.jsonl")))[0]).toEqual(header);
    await log.close();
  });

  it("a source that has no session id says only the entry", async () => {
    const memory = createMemoryLog();
    const first = await memory.append(say("hello"));
    const header = await forkLog(memory, join(dir, "from-memory.jsonl"));
    expect(header.forkedFrom).toEqual({ entry: first.id });
    const fork = await openFileLog(join(dir, "from-memory.jsonl"));
    expect((await fork.project()).map(textOf)).toEqual(["hello"]);
    await fork.close();
  });

  it("only the branch that is current: what was gone back from is not copied", async () => {
    const { log, entries } = await conversation();
    log.rewindTo(entries[1]!.id);
    const other = await log.append(say("a different question"));
    await forkLog(log, join(dir, "fork.jsonl"));
    expect(ids((await lines(join(dir, "fork.jsonl"))).slice(1))).toEqual([entries[0]!.id, entries[1]!.id, other.id]);
    await log.close();
  });

  it("an empty log gives an empty session without a source mark", async () => {
    const memory = createMemoryLog();
    const header = await forkLog(memory, join(dir, "empty.jsonl"));
    expect(header.forkedFrom).toBeUndefined();
    const fork = await openFileLog(join(dir, "empty.jsonl"));
    expect(await fork.project()).toEqual([]);
    await fork.close();
  });

  it("a point that is not on the current branch is refused, naming it", async () => {
    const { log, entries } = await conversation();
    log.rewindTo(entries[0]!.id);
    await expect(forkLog(log, join(dir, "fork.jsonl"), { upTo: entries[3]!.id })).rejects.toThrow(`entry ${entries[3]!.id} is not on the current branch`);
    await expect(forkLog(log, join(dir, "fork.jsonl"), { upTo: "nowhere" })).rejects.toThrow("is not on the current branch");
    expect((await readdir(dir)).filter((name) => name.startsWith("fork"))).toEqual([]);
    await log.close();
  });
});

describe("forking: what it keeps together", () => {
  async function turn(...resultsToWrite: string[]) {
    const log = createMemoryLog();
    await log.append(say("start"));
    const asking = await log.append(calls("c1", "c2"));
    const started = await log.append({ type: "tool_started", toolCallId: "c1", toolName: "bash" });
    const written: LogEntry[] = [];
    for (const id of resultsToWrite) written.push(await log.append(result(id)));
    await log.append(reply("all done"));
    return { log, asking, started, written };
  }
  const forkedIds = async (log: Awaited<ReturnType<typeof turn>>["log"], upTo: string) => {
    const path = join(dir, `f-${Math.random().toString(36).slice(2)}.jsonl`);
    await forkLog(log, path, { upTo });
    return ids((await lines(path)).slice(1));
  };

  it("at the message that makes the calls, the results that answer them come along", async () => {
    const { log, asking, written } = await turn("c1", "c2");
    const copied = await forkedIds(log, asking.id);
    expect(copied).toContain(written[0]!.id);
    expect(copied).toContain(written[1]!.id);
    expect(copied).not.toContain((await log.branch()).at(-1)!.id); // but not the reply after them
  });

  it("at the first result, the rest of the results come along", async () => {
    const { log, written } = await turn("c1", "c2");
    expect(await forkedIds(log, written[0]!.id)).toContain(written[1]!.id);
  });

  it("at the last result, nothing more is added", async () => {
    const { log, written } = await turn("c1", "c2");
    expect((await forkedIds(log, written[1]!.id)).at(-1)).toBe(written[1]!.id);
  });

  it("results that come in the other order are all kept", async () => {
    const { log, asking, written } = await turn("c2", "c1");
    const copied = await forkedIds(log, asking.id);
    expect(copied).toEqual(expect.arrayContaining([written[0]!.id, written[1]!.id]));
  });

  it("calls that were never answered in the source stay unanswered, and the next turn is not pulled in", async () => {
    const { log, asking } = await turn("c1"); // c2 never got a result
    const copied = await forkedIds(log, asking.id);
    expect((await log.branch()).at(-1)!.id).not.toBe(copied.at(-1));
    const text = await Promise.all(copied.map(async (id) => (await log.branch()).find((entry) => entry.id === id)));
    expect(text.some((entry) => entry?.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "text" && part.text === "all done"))).toBe(false);
  });

  it("a point in an earlier turn does not drag in the results of a later one", async () => {
    const log = createMemoryLog();
    const first = await log.append(say("one"));
    await log.append(calls("c1"));
    await log.append(result("c1"));
    await log.append(say("two"));
    expect(await forkedIds(log as never, first.id)).toEqual([first.id]);
  });

  for (const seed of Array.from({ length: 30 }, (_, index) => index + 1)) {
    it(`whatever the point, every call in the new session has its result unless the source never had one (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const log = createMemoryLog();
      let call = 0;
      for (let step = 0; step < 12; step++) {
        if (rng.chance(0.5)) {
          const wanted = Array.from({ length: rng.int(1, 3) }, () => `c${++call}`);
          await log.append(calls(...wanted));
          const answered = wanted.filter(() => rng.chance(0.85));
          for (const id of rng.chance(0.5) ? answered : [...answered].reverse()) {
            await log.append(result(id));
            if (rng.chance(0.3)) await log.append({ type: "tool_started", toolCallId: "x", toolName: "bash" });
          }
        } else {
          await log.append(rng.chance(0.5) ? say(`q${step}`) : reply(`a${step}`));
        }
      }
      const branch = await log.branch();
      const point = branch[rng.int(0, branch.length - 1)]!;
      const path = join(dir, `p${seed}.jsonl`);
      await forkLog(log, path, { upTo: point.id });
      const copied = (await lines(path)).slice(1) as LogEntry[];
      expect(ids(copied)).toEqual(ids(branch.slice(0, copied.length))); // a prefix of the source, nothing reordered
      expect(copied.length).toBeGreaterThanOrEqual(branch.indexOf(point) + 1);
      const answeredIn = (entries: readonly LogEntry[]) => new Set(entries.flatMap((entry) => (entry.type === "message" && entry.message.toolCallId ? [entry.message.toolCallId] : [])));
      const inFork = answeredIn(copied);
      const inSource = answeredIn(branch);
      const lastAssistant = [...copied].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (lastAssistant?.type === "message") {
        for (const part of lastAssistant.message.content) if (part.type === "tool_call" && inSource.has(part.id)) expect(inFork.has(part.id), part.id).toBe(true);
      }
    });
  }
});

describe("forking: what else comes along", () => {
  it("a compaction, the instructions pinned in front, the system prompt and the goal, so the model is shown the same thing", async () => {
    const log = createMemoryLog();
    await log.append({ type: "system_patch", sections: { system: "You are helpful." }, toolsAdded: [] });
    await log.append({ type: "custom_message", customType: "agents_md", pinned: true, content: text("Project rules") });
    const q1 = await log.append(say("q1"));
    await log.append(reply("a1"));
    await log.append({ type: "goal", goal: { objective: "ship it", status: "active", humanStreak: 0 } });
    const q2 = await log.append(say("q2"));
    await log.append({ type: "compaction", summary: "SUMMARY", firstKeptEntryId: q2.id, tokensBefore: 10 });
    await log.append(reply("a2"));
    await forkLog(log, join(dir, "fork.jsonl"));
    const fork = await openFileLog(join(dir, "fork.jsonl"));
    expect((await fork.project()).map(textOf)).toEqual((await log.project()).map(textOf));
    expect((await fork.branch()).map((entry) => entry.type)).toEqual((await log.branch()).map((entry) => entry.type));
    await fork.close();
    // a point before the compaction leaves it out
    await forkLog(log, join(dir, "early.jsonl"), { upTo: q1.id });
    expect((await lines(join(dir, "early.jsonl"))).some((entry) => entry.type === "compaction")).toBe(false);
  });
});

describe("forking: the two sessions are independent", () => {
  it("the source is not changed by a fork, not even by a byte", async () => {
    const { log, entries } = await conversation();
    await log.close();
    const before = await readFile(join(dir, "source.jsonl"), "utf8");
    const again = await openFileLog(join(dir, "source.jsonl"));
    await forkLog(again, join(dir, "fork.jsonl"), { upTo: entries[2]!.id });
    await again.close();
    expect(await readFile(join(dir, "source.jsonl"), "utf8")).toBe(before);
  });

  it("each goes on on its own, at the same time", async () => {
    const { log, entries } = await conversation();
    await forkLog(log, join(dir, "fork.jsonl"), { upTo: entries[1]!.id });
    const fork = await openFileLog(join(dir, "fork.jsonl")); // opens while the source is still open
    await fork.append(say("only in the fork"));
    await log.append(say("only in the source"));
    expect((await fork.project()).map(textOf)).toEqual(["q1", "a1", "only in the fork"]);
    expect((await log.project()).map(textOf)).toEqual(["q1", "a1", "q2", "a2", "q3", "only in the source"]);
    await fork.close();
    await log.close();
    const reopened = await openFileLog(join(dir, "fork.jsonl"));
    expect((await reopened.project()).map(textOf)).toEqual(["q1", "a1", "only in the fork"]);
    await reopened.close();
  });

  it("a second fork from the same point is a different session with the same content", async () => {
    const { log, entries } = await conversation();
    const one = await forkLog(log, join(dir, "one.jsonl"), { upTo: entries[1]!.id });
    const two = await forkLog(log, join(dir, "two.jsonl"), { upTo: entries[1]!.id });
    expect(one.id).not.toBe(two.id);
    expect((await lines(join(dir, "one.jsonl"))).slice(1)).toEqual((await lines(join(dir, "two.jsonl"))).slice(1));
    await log.close();
  });

  it("a fork of a fork says where it came from, one step back", async () => {
    const { log, entries } = await conversation();
    await forkLog(log, join(dir, "one.jsonl"), { upTo: entries[3]!.id, sessionId: log.header.id });
    const one = await openFileLog(join(dir, "one.jsonl"));
    const second = await forkLog(one, join(dir, "two.jsonl"), { upTo: entries[1]!.id, sessionId: one.header.id });
    expect(second.forkedFrom).toEqual({ entry: entries[1]!.id, session: one.header.id });
    await one.close();
    await log.close();
  });
});

describe("forking: a file that is there is never replaced, and none appears half written", () => {
  it("an existing file is refused and left as it was", async () => {
    const { log } = await conversation();
    await writeFile(join(dir, "taken.jsonl"), "precious\n");
    await expect(forkLog(log, join(dir, "taken.jsonl"))).rejects.toThrow("already exists");
    expect(await readFile(join(dir, "taken.jsonl"), "utf8")).toBe("precious\n");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await log.close();
  });

  it("the folders on the way are made", async () => {
    const { log } = await conversation();
    await forkLog(log, join(dir, "a", "b", "fork.jsonl"));
    expect((await lines(join(dir, "a", "b", "fork.jsonl")))[0]).toMatchObject({ type: "header" });
    await log.close();
  });

  it.skipIf(asRoot)("a folder that cannot be written to leaves nothing behind", async () => {
    const { log } = await conversation();
    await chmod(dir, 0o555);
    await expect(forkLog(log, join(dir, "fork.jsonl"))).rejects.toThrow();
    await chmod(dir, 0o755);
    expect((await readdir(dir)).filter((name) => name.startsWith("fork"))).toEqual([]);
    await log.close();
  });
});
