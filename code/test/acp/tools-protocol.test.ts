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

  it("available_commands_update follows session/new and lists the commands", async () => {
    start([]);
    await harness!.start();
    await sleep(50);
    const [menu] = updates(harness!, "available_commands_update");
    assert.deepEqual((menu!.availableCommands as Array<{ name: string }>).map((command) => command.name), ["compact", "status", "goal", "undo", "fork", "review", "init", "mcp", "loop", "in"]);
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

  describe("/goal", () => {
    const text = (from = 0) => updates(harness!, "agent_message_chunk").slice(from).map((update) => (update.content as { text: string }).text).join("");
    // the goal check asks the model for a checklist; the first answer leaves an item open, the second closes it
    const checking = () => {
      let checks = 0;
      return (request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
        const last = request.messages.at(-1)?.content.map((part) => part.text ?? "").join("") ?? "";
        if (last.includes("about to stop")) return { text: ++checks === 1 ? "- [todo] the tests pass :: not run yet" : "- [done] the tests pass :: ran them" };
        return { text: "working on it" };
      };
    };

    it("alone it says there is no goal; it starts no run", async () => {
      start([]);
      const { sessionId } = await harness!.start();
      const response = await prompt(harness!, sessionId, "/goal");
      assert.equal(response.stopReason, "end_turn");
      assert.match(text(), /No goal is set/);
    });

    it("sets the goal, works on it with the objective as the prompt, echoes the goal check, and ends when it is reached", async () => {
      start(checking());
      const { sessionId } = await harness!.start();
      const response = await prompt(harness!, sessionId, "/goal make the tests pass");
      assert.equal(response.stopReason, "end_turn");
      const said = text();
      assert.match(said, /Goal set/);
      assert.match(said, /Goal check: the goal is not finished yet/);
      assert.match(said, /the tests pass/);
      assert.match(said, /Goal reached/);
      assert.match(said, /working on it/);
      const shown = await prompt(harness!, sessionId, "/goal");
      assert.equal(shown.stopReason, "end_turn");
      assert.match(text(), /Goal \(complete\): make the tests pass/);
    });

    it("clear (and off) ends the goal", async () => {
      start(checking());
      const { sessionId } = await harness!.start();
      await harness!.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/goal make the tests pass" }] });
      const before = updates(harness!, "agent_message_chunk").length;
      await prompt(harness!, sessionId, "/goal clear");
      assert.match(text(before), /Goal cleared/);
      await prompt(harness!, sessionId, "/goal off");
      assert.match(text(), /Goal cleared/);
    });

    it("cannot be changed while a turn runs", async () => {
      start([{ hang: true }]);
      const { sessionId } = await harness!.start();
      const running = prompt(harness!, sessionId, "wait");
      await sleep(100);
      await assert.rejects(prompt(harness!, sessionId, "/goal something"), (error: { code?: number }) => error.code === -32001);
      await harness!.connection.agent.notify(methods.agent.session.cancel, { sessionId });
      await running;
    });
  });

  describe("/undo, /fork, /review, /init and /mcp", () => {
    const said = () => updates(harness!, "agent_message_chunk").map((update) => (update.content as { text: string }).text).join("");

    it("/undo goes back to before the last message, shows it again, and the model no longer sees it", async () => {
      let sent: string[] = [];
      start((request) => {
        sent = request.messages.map((message) => JSON.stringify(message.content));
        return { text: "reply" };
      });
      const { sessionId } = await harness!.start();
      await prompt(harness!, sessionId, "first question");
      await prompt(harness!, sessionId, "second question");
      const response = await prompt(harness!, sessionId, "/undo");
      assert.equal(response.stopReason, "end_turn");
      assert.match(said(), /Went back to before your last message[\s\S]*second question/);
      await prompt(harness!, sessionId, "a different question");
      const all = sent.join(" ");
      assert.match(all, /first question/);
      assert.match(all, /a different question/);
      assert.doesNotMatch(all, /second question/);
    });

    it("/undo with nothing to undo says so", async () => {
      start([]);
      const { sessionId } = await harness!.start();
      await prompt(harness!, sessionId, "/undo");
      assert.match(said(), /no message to undo/);
    });

    it("/fork copies the conversation into a new stored session, tells the id and the limit, and leaves this session alone", async () => {
      start([{ text: "one" }, { text: "two" }]);
      const { sessionId } = await harness!.start();
      await prompt(harness!, sessionId, "talk to me");
      await prompt(harness!, sessionId, "/fork");
      const match = /Forked into session ([0-9a-f-]{36})/.exec(said());
      assert.ok(match, said());
      assert.match(said(), /session\/load/);
      const child = JSON.parse(await readFile(join(sandbox.directory, "sessions", `${match![1]}.meta.json`), "utf8"));
      assert.equal(child.parentId, sessionId);
      assert.equal(child.title, "fork: talk to me");
      assert.ok((await readFile(join(sandbox.directory, "sessions", `${match![1]}.jsonl`), "utf8")).includes("talk to me"));
      assert.equal((await prompt(harness!, sessionId, "still here?")).stopReason, "end_turn");
    });

    it("/fork before anything was said has nothing to copy", async () => {
      start([]);
      const { sessionId } = await harness!.start();
      await prompt(harness!, sessionId, "/fork");
      assert.match(said(), /nothing to fork yet/);
    });

    it("/review and /init send the terminal's prompts to the agent", async () => {
      const seen: string[] = [];
      start((request) => {
        seen.push(JSON.stringify(request.messages.at(-1)!.content));
        return { text: "ok" };
      });
      const { sessionId } = await harness!.start();
      await prompt(harness!, sessionId, "/review the error handling");
      await prompt(harness!, sessionId, "/init");
      assert.match(seen[0]!, /\[\/review\] Review the uncommitted changes[\s\S]*Focus of this review: the error handling/);
      assert.match(seen[1]!, /\[\/init\] Create an AGENTS.md/);
    });

    it("/mcp says when no server is configured", async () => {
      start([]);
      const { sessionId } = await harness!.start();
      await prompt(harness!, sessionId, "/mcp");
      assert.match(said(), /No MCP servers are configured/);
    });

    it("/mcp shows the servers the client listed and whether they connected", async () => {
      start([]);
      await harness!.initialize();
      const created = await harness!.connection.agent.request(methods.agent.session.new, {
        cwd: sandbox.directory,
        mcpServers: [{ name: "stub", command: process.execPath, args: [new URL("./support/mcp-stub.mjs", import.meta.url).pathname], env: [] }],
      });
      await prompt(harness!, created.sessionId, "/mcp");
      assert.match(said(), /\| `stub` \| connected \| 1 \|/);
    });
  });
});
