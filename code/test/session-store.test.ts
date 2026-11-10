import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSessionStore, sessionLabel, titleFromPrompt } from "../src/session-store.ts";
import type { SessionStore } from "../src/session-store.ts";

describe("session store", () => {
  let directory: string;
  let store: SessionStore;
  let clock = 1000;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sakura-store-"));
    clock = 1000;
    store = createSessionStore(join(directory, "sessions"), { now: () => (clock += 10) });
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("creates sessions, lists newest first and updates metadata", async () => {
    const a = await store.create({ cwd: "/a", provider: "p", model: "m" });
    const b = await store.create({ cwd: "/b", provider: "p", model: "m" });
    assert.deepEqual((await store.list()).map((meta) => meta.id), [b.id, a.id]);
    await store.update(a.id, { title: "first" });
    assert.deepEqual((await store.list()).map((meta) => meta.id), [a.id, b.id]);
    assert.equal((await store.get(a.id))?.title, "first");
  });

  it("filters by working directory", async () => {
    await store.create({ cwd: "/a", provider: "p", model: "m" });
    const b = await store.create({ cwd: "/b", provider: "p", model: "m" });
    assert.deepEqual((await store.list({ cwd: "/b" })).map((meta) => meta.id), [b.id]);
  });

  it("finds by id, unique prefix, 'last' and file path", async () => {
    const a = await store.create({ cwd: "/a", provider: "p", model: "m" });
    const b = await store.create({ cwd: "/a", provider: "p", model: "m" });
    assert.equal((await store.find(a.id))?.id, a.id);
    assert.equal((await store.find(b.id.slice(0, 12)))?.id, b.id);
    assert.equal((await store.find("last"))?.id, b.id);
    assert.equal((await store.find(store.sessionFile(a.id)))?.id, a.id);
    assert.equal(await store.find("zzzz"), undefined);
  });

  it("refuses an ambiguous prefix", async () => {
    await store.create({ cwd: "/a", provider: "p", model: "m" });
    await store.create({ cwd: "/a", provider: "p", model: "m" });
    await assert.rejects(() => store.find(""), /matches 2 sessions/);
  });

  it("records the parent of a fork and an empty store lists nothing", async () => {
    assert.deepEqual(await store.list(), []);
    const parent = await store.create({ cwd: "/a", provider: "p", model: "m" });
    const child = await store.create({ cwd: "/a", provider: "p", model: "m", parentId: parent.id });
    assert.equal(child.parentId, parent.id);
  });

  it("update of an unknown session fails", async () => {
    await assert.rejects(() => store.update("nope", { title: "x" }), /no session nope/);
  });

  it("labels and titles", () => {
    assert.equal(titleFromPrompt("  fix the bug\nplease  "), "fix the bug");
    assert.equal(titleFromPrompt("x".repeat(100)).length, 60);
    assert.match(sessionLabel({ id: "abcdef123456", cwd: "/", provider: "p", model: "m", createdAt: 0, updatedAt: 0 }), /untitled abcdef12/);
  });
});
