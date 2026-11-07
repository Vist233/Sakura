// One suite, every implementation of RewindableLog. A new implementation must pass all of it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@sakura/kernel";
import { createMemoryLog, openFileLog } from "../src/index.ts";
import type { RewindableLog } from "../src/index.ts";
import { text, textOf } from "./helpers.ts";

type Make = () => Promise<{ log: RewindableLog; close(): Promise<void> }>;
const say = (value: string, role: "user" | "assistant" = "user") => ({ type: "message" as const, message: { role, content: text(value), ts: 1 } as Message });

let dir: string;
let counter = 0;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contract-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const implementations: Array<[string, () => Make]> = [
  ["memory log", () => async () => ({ log: createMemoryLog(), close: async () => undefined })],
  [
    "file log",
    () => async () => {
      const log = await openFileLog(join(dir, `s${++counter}.jsonl`), { cwd: dir });
      return { log, close: () => log.close() };
    },
  ],
];

for (const [name, factory] of implementations) {
  describe(`Log contract: ${name}`, () => {
    let open: Array<() => Promise<void>> = [];
    const make = async () => {
      const made = await factory()();
      open.push(made.close);
      return made.log;
    };
    afterEach(async () => {
      for (const close of open) await close();
      open = [];
    });

    it("a new log is empty", async () => {
      const log = await make();
      expect(await log.branch()).toEqual([]);
      expect(await log.project()).toEqual([]);
      expect(log.leaf()).toBeNull();
    });

    it("append returns the entry with an id, a parent and a timestamp, and it becomes the leaf", async () => {
      const log = await make();
      const first = await log.append(say("a"));
      const second = await log.append(say("b", "assistant"));
      expect(first.parentId).toBeNull();
      expect(second.parentId).toBe(first.id);
      expect(second.id).not.toBe(first.id);
      expect(typeof first.ts).toBe("number");
      expect(log.leaf()).toBe(second.id);
    });

    it("branch lists the entries from the root in order", async () => {
      const log = await make();
      for (const value of ["a", "b", "c"]) await log.append(say(value));
      expect((await log.branch()).map((entry) => (entry.type === "message" ? textOf(entry.message) : ""))).toEqual(["a", "b", "c"]);
    });

    it("project returns the messages in order", async () => {
      const log = await make();
      await log.append(say("question"));
      await log.append(say("answer", "assistant"));
      expect((await log.project()).map((message) => `${message.role}:${textOf(message)}`)).toEqual(["user:question", "assistant:answer"]);
    });

    it("project(upTo) shows the messages before that entry", async () => {
      const log = await make();
      await log.append(say("a"));
      const second = await log.append(say("b", "assistant"));
      await log.append(say("c"));
      expect((await log.project(second.id)).map(textOf)).toEqual(["a"]);
    });

    it("the arrays it returns are copies", async () => {
      const log = await make();
      await log.append(say("a"));
      ((await log.branch()) as unknown[]).length = 0;
      expect(await log.branch()).toHaveLength(1);
    });

    it("rewindTo goes back, and the next entry starts a new branch", async () => {
      const log = await make();
      const first = await log.append(say("a"));
      await log.append(say("b", "assistant"));
      log.rewindTo(first.id);
      expect(log.leaf()).toBe(first.id);
      await log.append(say("b2", "assistant"));
      expect((await log.project()).map(textOf)).toEqual(["a", "b2"]);
    });

    it("rewindTo(null) goes to the very start", async () => {
      const log = await make();
      await log.append(say("a"));
      log.rewindTo(null);
      expect(await log.branch()).toEqual([]);
      const again = await log.append(say("fresh"));
      expect(again.parentId).toBeNull();
    });

    it("rewindTo an unknown id throws and changes nothing", async () => {
      const log = await make();
      const first = await log.append(say("a"));
      expect(() => log.rewindTo("no-such-id")).toThrow();
      expect(log.leaf()).toBe(first.id);
    });

    it("keeps non-message entries in the branch but not in the projection", async () => {
      const log = await make();
      await log.append(say("a"));
      await log.append({ type: "custom", customType: "note", data: { x: 1 } });
      expect(await log.branch()).toHaveLength(2);
      expect((await log.project()).map(textOf)).toEqual(["a"]);
    });

    it("a pinned custom message is projected as a user message", async () => {
      const log = await make();
      await log.append({ type: "custom_message", customType: "context", content: text("project rules"), pinned: true });
      const projected = await log.project();
      expect(projected).toHaveLength(1);
      expect(projected[0]!.role).toBe("user");
      expect(textOf(projected[0]!)).toBe("project rules");
    });

    it("many appends keep a single chain", async () => {
      const log = await make();
      for (let index = 0; index < 60; index++) await log.append(say(`m${index}`, index % 2 === 0 ? "user" : "assistant"));
      const branch = await log.branch();
      expect(branch).toHaveLength(60);
      expect(branch.every((entry, index) => entry.parentId === (index === 0 ? null : branch[index - 1]!.id))).toBe(true);
    });

    it("concurrent appends are all kept, each with its own id", async () => {
      const log = await make();
      await Promise.all(Array.from({ length: 20 }, (_, index) => log.append(say(`p${index}`))));
      const ids = (await log.branch()).map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(20);
    });
  });
}

describe("Log contract: the file log also survives a restart", () => {
  it("reopening the file gives the same branch and projection", async () => {
    const file = join(dir, "restart.jsonl");
    const first = await openFileLog(file, { cwd: dir });
    await first.append(say("a"));
    await first.append(say("b", "assistant"));
    const before = await first.branch();
    await first.close();
    const second = await openFileLog(file, { cwd: dir });
    expect(await second.branch()).toEqual(before);
    expect((await second.project()).map(textOf)).toEqual(["a", "b"]);
    await second.close();
  });
});
