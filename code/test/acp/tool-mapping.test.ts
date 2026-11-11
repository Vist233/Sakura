import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUpdateMapper } from "../../src/acp/events-to-updates.ts";
import { capped, cut, describeCall, describeResult, MAX_CARD_TEXT } from "../../src/acp/tool-mapping.ts";
import { parseCommand, AVAILABLE_COMMANDS } from "../../src/acp/commands.ts";
import type { Event, ToolCall } from "../../src/framework.ts";

const call = (name: string, args: unknown, id = "c1"): ToolCall => ({ id, name, args });
const ctx = { cwd: "/work/project" };

describe("tool cards: calls (L1)", () => {
  it("read: kind read, absolute location, 1-based line from the offset, range in the title", () => {
    assert.deepEqual(describeCall(call("read", { path: "src/a.ts", offset: 10, limit: 5 }), ctx), {
      kind: "read",
      title: "Read src/a.ts:10-14",
      locations: [{ path: "/work/project/src/a.ts", line: 10 }],
      content: [],
      rawInput: { path: "src/a.ts", offset: 10, limit: 5 },
    });
    assert.equal(describeCall(call("read", { path: "/etc/hosts" }), ctx).locations[0]!.path, "/etc/hosts");
    assert.equal(describeCall(call("read", { path: "a", offset: 3 }), ctx).title, "Read a:3");
  });

  it("edit: kind edit, one diff per replacement, the count in the title", () => {
    const card = describeCall(call("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] }), ctx);
    assert.equal(card.kind, "edit");
    assert.equal(card.title, "Edit a.ts (2 changes)");
    assert.deepEqual(card.content, [
      { type: "diff", path: "/work/project/a.ts", oldText: "x", newText: "y" },
      { type: "diff", path: "/work/project/a.ts", oldText: "p", newText: "q" },
    ]);
  });

  it("write: a diff against what the file held, against nothing for a new file, and no diff while that is not known", () => {
    assert.deepEqual(describeCall(call("write", { path: "n.txt", content: "new" }), { ...ctx, previous: "old" }).content, [{ type: "diff", path: "/work/project/n.txt", oldText: "old", newText: "new" }]);
    assert.deepEqual(describeCall(call("write", { path: "n.txt", content: "new" }), { ...ctx, previous: null }).content, [{ type: "diff", path: "/work/project/n.txt", oldText: null, newText: "new" }]);
    assert.deepEqual(describeCall(call("write", { path: "n.txt", content: "new" }), ctx).content, []);
  });

  it("bash: kind execute, the first line as the title, the command as text", () => {
    const card = describeCall(call("bash", { command: "npm test\n&& echo done" }), ctx);
    assert.equal(card.kind, "execute");
    assert.equal(card.title, "npm test");
    assert.deepEqual(card.content, [{ type: "content", content: { type: "text", text: "$ npm test\n&& echo done" } }]);
    assert.equal(describeCall(call("bash", { command: "x".repeat(300) }), ctx).title.length, 121);
  });

  it("other tools: a kind from the name, the name as title", () => {
    assert.equal(describeCall(call("web_fetch", { url: "u" }), ctx).kind, "fetch");
    assert.equal(describeCall(call("grep_files", {}), ctx).kind, "search");
    assert.deepEqual([describeCall(call("agents_spawn", {}), ctx).kind, describeCall(call("agents_spawn", {}), ctx).title], ["other", "agents_spawn"]);
  });

  it("never throws on malformed arguments", () => {
    for (const args of [undefined, null, 5, "x", [], { path: 5 }, { edits: "no" }, { edits: [5, null, {}] }, { command: 7 }]) {
      for (const name of ["read", "write", "edit", "bash", "other"]) assert.doesNotThrow(() => describeCall(call(name, args), ctx), `${name} ${JSON.stringify(args)}`);
    }
  });

  it("cuts long text and says how much was cut", () => {
    const long = "a".repeat(MAX_CARD_TEXT + 50);
    assert.match(cut(long), /50 more characters not shown/);
    assert.equal(cut("short"), "short");
    const card = describeCall(call("write", { path: "big", content: long }), ctx);
    assert.ok((card.rawInput as { content: string }).content.length < long.length);
    assert.deepEqual(capped({ a: [1, "x"], b: { c: null } }), { a: [1, "x"], b: { c: null } });
    assert.equal(capped({ deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } }) !== undefined, true);
  });
});

describe("tool cards: results (L1)", () => {
  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  it("completed and failed", () => {
    assert.equal(describeResult(call("bash", { command: "ls" }), ok("a b"), ctx).status, "completed");
    const failed = describeResult(call("bash", { command: "false" }), { ...ok("exit 1"), isError: true }, ctx);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.rawOutput, { text: "exit 1", isError: true });
  });

  it("a command shows its command, then its output", () => {
    const card = describeResult(call("bash", { command: "ls" }), ok("file.txt"), ctx);
    assert.deepEqual(card.content.map((part) => (part.type === "content" ? part.content.text : part.type)), ["$ ls", "file.txt"]);
  });

  it("a finished edit keeps its diff; a failed one shows the error only", () => {
    const edit = call("edit", { path: "a", edits: [{ oldText: "x", newText: "y" }] });
    assert.deepEqual(describeResult(edit, ok("Successfully replaced"), ctx).content.map((part) => part.type), ["diff", "content"]);
    assert.deepEqual(describeResult(edit, { ...ok("no match"), isError: true }, ctx).content.map((part) => part.type), ["content"]);
  });

  it("images in a result become a marker, empty output gives no text block", () => {
    const card = describeResult(call("read", { path: "i.png" }), { content: [{ type: "image", mediaType: "image/png", ref: "r" }] }, ctx);
    assert.deepEqual(card.content, [{ type: "content", content: { type: "text", text: "[image]" } }]);
    assert.deepEqual(describeResult(call("read", { path: "e" }), { content: [] }, ctx).content, []);
  });
});

describe("mapper: cards and the context meter (L1)", () => {
  const message = (usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }): Event => ({ type: "message_end", message: { role: "assistant", content: [], ts: 0, ...(usage ? { usage } : {}) } });

  it("a tool call is a tool_call and then a tool_call_update with the same id", () => {
    const mapper = createUpdateMapper({ cwd: "/w", contextWindow: 0 });
    const start = mapper.push({ type: "tool_start", call: call("bash", { command: "ls" }, "t9") });
    const end = mapper.push({ type: "tool_end", call: call("bash", { command: "ls" }, "t9"), result: { content: [{ type: "text", text: "x" }] } });
    assert.deepEqual([start[0]!.sessionUpdate, end[0]!.sessionUpdate], ["tool_call", "tool_call_update"]);
    assert.equal((start[0] as { status: string }).status, "in_progress");
    assert.equal((end[0] as { status: string }).status, "completed");
    assert.equal((start[0] as { toolCallId: string }).toolCallId, "t9");
    assert.equal((end[0] as { toolCallId: string }).toolCallId, "t9");
  });

  it("usage_update after a reply that reports usage, with the window; none without usage or without a window", () => {
    const usage = { input: 1000, output: 50, cacheRead: 200, cacheWrite: 10 };
    assert.deepEqual(createUpdateMapper({ cwd: "/w", contextWindow: 128000 }).push(message(usage)), [{ sessionUpdate: "usage_update", used: 1260, size: 128000 }]);
    assert.deepEqual(createUpdateMapper({ cwd: "/w", contextWindow: 128000 }).push(message()), []);
    assert.deepEqual(createUpdateMapper({ cwd: "/w", contextWindow: 0 }).push(message(usage)), []);
  });

  it("the previous content of a write comes through the callback", () => {
    const mapper = createUpdateMapper({ cwd: "/w", contextWindow: 0, previous: (id) => (id === "w1" ? "OLD" : undefined) });
    const [update] = mapper.push({ type: "tool_start", call: call("write", { path: "f", content: "NEW" }, "w1") });
    assert.deepEqual((update as { content: unknown }).content, [{ type: "diff", path: "/w/f", oldText: "OLD", newText: "NEW" }]);
  });

  it("property: a card never throws and a tool_call always names its update", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const names = ["read", "write", "edit", "bash", "mcp_thing"];
    for (let round = 0; round < 200; round++) {
      const mapper = createUpdateMapper({ cwd: "/w", contextWindow: 1000 });
      const open = new Set<string>();
      for (let step = 0; step < 20; step++) {
        const id = `c${Math.floor(random() * 5)}`;
        const tool = call(names[Math.floor(random() * names.length)]!, random() < 0.3 ? null : { path: "p", content: "c", command: "k", edits: [{ oldText: "a", newText: "b" }] }, id);
        if (random() < 0.5 && !open.has(id)) {
          open.add(id);
          assert.equal(mapper.push({ type: "tool_start", call: tool })[0]!.sessionUpdate, "tool_call");
        } else if (open.has(id)) {
          open.delete(id);
          const [update] = mapper.push({ type: "tool_end", call: tool, result: { content: [{ type: "text", text: "r" }], ...(random() < 0.3 ? { isError: true } : {}) } });
          assert.equal((update as { toolCallId: string }).toolCallId, id);
        }
      }
    }
  });
});

describe("commands (L1)", () => {
  it("parses /compact, /status and the forms of /goal", () => {
    assert.deepEqual(parseCommand("/compact"), { name: "compact" });
    assert.deepEqual(parseCommand("  /status \n"), { name: "status" });
    assert.deepEqual(parseCommand("/goal"), { name: "goal", action: "show" });
    assert.deepEqual(parseCommand("/goal   "), { name: "goal", action: "show" });
    assert.deepEqual(parseCommand("/goal clear"), { name: "goal", action: "clear" });
    assert.deepEqual(parseCommand("/goal OFF"), { name: "goal", action: "clear" });
    assert.deepEqual(parseCommand("/goal make the build green\nand the tests"), { name: "goal", action: "set", objective: "make the build green\nand the tests" });
    assert.deepEqual(parseCommand("/goal clearing the cache"), { name: "goal", action: "set", objective: "clearing the cache" });
  });
  it("leaves everything else as an ordinary prompt", () => {
    for (const other of ["/compact now", "/status x", "hello /status", "compact", "/Status", "/goals", "/goalpost"]) assert.equal(parseCommand(other), undefined, other);
  });
  it("advertises exactly the commands it can handle, goal with an input hint", () => {
    assert.deepEqual(AVAILABLE_COMMANDS.map((command) => command.name), ["compact", "status", "goal"]);
    assert.ok(AVAILABLE_COMMANDS.find((command) => command.name === "goal")!.input!.hint.length > 0);
  });
});

describe("mapper: goal events (L1)", () => {
  it("says when the goal is reached or blocked, and nothing for other states", () => {
    const mapper = createUpdateMapper({ cwd: "/w", contextWindow: 0 });
    const text = (updates: ReturnType<typeof mapper.push>) => updates.map((update) => ("content" in update ? (update.content as { text: string }).text : "")).join("");
    assert.match(text(mapper.push({ type: "goal", status: "complete" })), /Goal reached/);
    assert.match(text(mapper.push({ type: "goal", status: "blocked" })), /Goal blocked/);
    assert.deepEqual(mapper.push({ type: "goal", status: "active" }), []);
  });
});
