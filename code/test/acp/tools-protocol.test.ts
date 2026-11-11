// Tool cards, the context meter and slash commands over the SDK client (L2).
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { methods } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Update = SessionNotification["update"] & Record<string, unknown>;
const updates = (harness: Harness, kind: string): Update[] => harness.updates.map((item) => item.update as Update).filter((update) => update.sessionUpdate === kind);
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
const usage = { input: 4000, output: 100, cacheRead: 0, cacheWrite: 0 };

describe("tool cards over the SDK client (L2)", () => {
  let sandbox: Sandbox;
  let harness: Harness | undefined;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    harness = undefined;
  });
  afterEach(async () => {
    await harness?.stop();
    await sandbox.cleanup();
  });
  // no review: the scripted model would otherwise answer the reviewer's questions too
  const start = (script: Parameters<typeof startHarness>[1]) => (harness = startHarness(sandbox, script, { permissions: "full-access" }));

  it("a new file: the completed update carries a diff against nothing; the file exists", async () => {
    start([{ toolCalls: [{ name: "write", id: "w1", args: { path: "notes.txt", content: "hello" } }] }, { text: "done", usage }]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "write it");
    const [card] = updates(harness!, "tool_call");
    assert.equal(card!.toolCallId, "w1");
    assert.equal(card!.kind, "edit");
    assert.equal(card!.status, "in_progress");
    assert.deepEqual(card!.locations, [{ path: join(sandbox.directory, "notes.txt") }]);
    const [done] = updates(harness!, "tool_call_update");
    assert.equal(done!.status, "completed");
    assert.deepEqual((done!.content as Array<{ type: string }>)[0], { type: "diff", path: join(sandbox.directory, "notes.txt"), oldText: null, newText: "hello" });
    assert.equal(await readFile(join(sandbox.directory, "notes.txt"), "utf8"), "hello");
  });

  it("overwriting a file: the diff starts from what the file held", async () => {
    await writeFile(join(sandbox.directory, "a.txt"), "before");
    start([{ toolCalls: [{ name: "write", id: "w2", args: { path: "a.txt", content: "after" } }] }, { text: "ok" }]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "overwrite");
    assert.deepEqual((updates(harness!, "tool_call_update")[0]!.content as Array<{ type: string }>)[0], { type: "diff", path: join(sandbox.directory, "a.txt"), oldText: "before", newText: "after" });
  });

  it("an edit shows old and new text; a failing edit shows its error with status failed", async () => {
    await writeFile(join(sandbox.directory, "e.txt"), "one two three");
    start([
      { toolCalls: [{ name: "edit", id: "e1", args: { path: "e.txt", edits: [{ oldText: "two", newText: "2" }] } }] },
      { toolCalls: [{ name: "edit", id: "e2", args: { path: "e.txt", edits: [{ oldText: "missing text", newText: "x" }] } }] },
      { text: "done" },
    ]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "edit twice");
    const cards = updates(harness!, "tool_call");
    assert.deepEqual(cards[0]!.content, [{ type: "diff", path: join(sandbox.directory, "e.txt"), oldText: "two", newText: "2" }]);
    const results = updates(harness!, "tool_call_update");
    assert.deepEqual(results.map((result) => result.status), ["completed", "failed"]);
    assert.equal(await readFile(join(sandbox.directory, "e.txt"), "utf8"), "one 2 three");
  });

  it("a command: kind execute, its output as text", async () => {
    start([{ toolCalls: [{ name: "bash", id: "b1", args: { command: "echo hello-from-bash" } }] }, { text: "done" }]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "run it");
    assert.equal(updates(harness!, "tool_call")[0]!.kind, "execute");
    const text = JSON.stringify(updates(harness!, "tool_call_update")[0]!.content);
    assert.match(text, /hello-from-bash/);
  });

  it("a read: kind read with the absolute location", async () => {
    await writeFile(join(sandbox.directory, "r.txt"), "line1\nline2\n");
    start([{ toolCalls: [{ name: "read", id: "r1", args: { path: "r.txt" } }] }, { text: "done" }]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "read it");
    const [card] = updates(harness!, "tool_call");
    assert.equal(card!.kind, "read");
    assert.deepEqual(card!.locations, [{ path: join(sandbox.directory, "r.txt") }]);
  });

  it("order: every update of a call comes after its tool_call, ids are unique, nothing after the response", async () => {
    start([{ toolCalls: [{ name: "bash", id: "x1", args: { command: "true" } }, { name: "bash", id: "x2", args: { command: "true" } }] }, { text: "done", usage }]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "two commands");
    const seen = new Set<string>();
    const closed = new Set<string>();
    for (const item of harness!.updates) {
      const update = item.update as Update;
      if (update.sessionUpdate === "tool_call") {
        assert.ok(!seen.has(String(update.toolCallId)), "unique ids");
        seen.add(String(update.toolCallId));
      } else if (update.sessionUpdate === "tool_call_update") {
        assert.ok(seen.has(String(update.toolCallId)), "the call was announced first");
        assert.ok(!closed.has(String(update.toolCallId)), "one result per call");
        closed.add(String(update.toolCallId));
      }
    }
    assert.deepEqual([...closed].sort(), ["x1", "x2"]);
    const count = harness!.updates.length;
    await sleep(60);
    assert.equal(harness!.updates.length, count);
  });

  it("usage_update follows a reply that reports usage, with the model's window", async () => {
    start([{ text: "hi", usage }]);
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "hi");
    const meter = updates(harness!, "usage_update");
    assert.equal(meter.at(-1)!.used, 4100);
    assert.ok(Number(meter.at(-1)!.size) > 0);
  });

  it("available_commands_update follows session/new and lists /compact and /status", async () => {
    start([]);
    await harness!.start();
    await sleep(50);
    const [menu] = updates(harness!, "available_commands_update");
    assert.deepEqual((menu!.availableCommands as Array<{ name: string }>).map((command) => command.name), ["compact", "status"]);
  });

  it("/status answers with the table and starts no run", async () => {
    start([]);
    const { sessionId } = await harness!.start();
    const response = await prompt(harness!, sessionId, "/status");
    assert.equal(response.stopReason, "end_turn");
    const text = updates(harness!, "agent_message_chunk").map((update) => (update.content as { text: string }).text).join("");
    assert.match(text, /\| \*\*Session\*\*/);
    assert.match(text, /full-access/);
  });

  it("/compact summarises the conversation, says so and moves the meter", async () => {
    start((request, index) => (request.system.includes("summar") || JSON.stringify(request.messages).includes("<conversation>") ? { text: "SUMMARY" } : { text: `reply ${index}`, usage: { input: 3000, output: 50, cacheRead: 0, cacheWrite: 0 } }));
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, `first ${"word ".repeat(2000)}`);
    await prompt(harness!, sessionId, `second ${"word ".repeat(2000)}`);
    const before = harness!.updates.length;
    const response = await prompt(harness!, sessionId, "/compact");
    assert.equal(response.stopReason, "end_turn");
    const after = harness!.updates.slice(before).map((item) => item.update as Update);
    assert.ok(after.some((update) => update.sessionUpdate === "agent_message_chunk" && /Context compacted/.test((update.content as { text: string }).text)), JSON.stringify(after.map((u) => u.sessionUpdate)));
    assert.ok(after.some((update) => update.sessionUpdate === "usage_update"));
  });

  it("an unknown slash command is an ordinary prompt", async () => {
    start((request) => ({ text: JSON.stringify(request.messages).includes("/frobnicate") ? "got it" : "missed" }));
    const { sessionId } = await harness!.start();
    await prompt(harness!, sessionId, "/frobnicate now");
    assert.equal(updates(harness!, "agent_message_chunk").map((update) => (update.content as { text: string }).text).join(""), "got it");
  });
});
