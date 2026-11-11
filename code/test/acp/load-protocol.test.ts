// session/load, image and resource prompts, and client MCP servers over the SDK client (L2).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { methods, RequestError } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Update = SessionNotification["update"] & Record<string, unknown>;
const kinds = (list: SessionNotification[]) => list.map((item) => item.update.sessionUpdate);
const textOf = (list: SessionNotification[], kind: string) => list.filter((item) => item.update.sessionUpdate === kind).map((item) => (item.update as Update & { content: { text: string } }).content.text).join("");
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
const failure = async (work: Promise<unknown>): Promise<RequestError> => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof RequestError, String(error));
    return error;
  }
  assert.fail("expected the request to fail");
};
// a 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("session/load, attachments and MCP (L2)", () => {
  let sandbox: Sandbox;
  let first: Harness | undefined;
  let second: Harness | undefined;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    first = second = undefined;
  });
  afterEach(async () => {
    await first?.stop();
    await second?.stop();
    await sandbox.cleanup();
  });

  it("loads an earlier session in a new process: the replay has the same messages and cards as the live run, and the conversation goes on", async () => {
    first = startHarness(sandbox, [{ toolCalls: [{ name: "bash", id: "t1", args: { command: "echo replayed" } }] }, { text: "All done." }], { permissions: "full-access" });
    const created = await first.start();
    await prompt(first, created.sessionId, "run a command");
    const live = first.updates.slice();
    await first.stop();

    second = startHarness(sandbox, (request) => ({ text: JSON.stringify(request.messages).includes("run a command") ? "I remember it" : "I do not" }), { permissions: "full-access" });
    await second.initialize();
    const loaded = await second.connection.agent.request(methods.agent.session.load, { sessionId: created.sessionId, cwd: sandbox.directory, mcpServers: [] });
    assert.ok(Array.isArray(loaded.configOptions));
    const replay = second.updates.slice();
    assert.equal(textOf(replay, "user_message_chunk"), "run a command");
    assert.equal(textOf(replay, "agent_message_chunk"), textOf(live, "agent_message_chunk"));
    const cards = (list: SessionNotification[]) => list.filter((item) => ["tool_call", "tool_call_update"].includes(item.update.sessionUpdate)).map((item) => `${item.update.sessionUpdate}:${(item.update as Update).toolCallId}:${(item.update as Update).status}`);
    assert.deepEqual(cards(replay), cards(live));
    assert.ok(kinds(replay).includes("usage_update"));
    const before = second.updates.length;
    await prompt(second, created.sessionId, "do you remember?");
    assert.equal(textOf(second.updates.slice(before), "agent_message_chunk"), "I remember it", "the history is in the agent's context");
  });

  it("loading twice replays twice and keeps one session", async () => {
    first = startHarness(sandbox, [{ text: "hello" }, { text: "again" }]);
    const created = await first.start();
    await prompt(first, created.sessionId, "hi");
    const before = first.updates.length;
    await first.connection.agent.request(methods.agent.session.load, { sessionId: created.sessionId, cwd: sandbox.directory, mcpServers: [] });
    assert.equal(textOf(first.updates.slice(before), "agent_message_chunk"), "hello");
    assert.equal((await prompt(first, created.sessionId, "again")).stopReason, "end_turn");
  });

  it("an unknown session id or a relative cwd is an error", async () => {
    first = startHarness(sandbox, []);
    await first.initialize();
    assert.equal((await failure(first.connection.agent.request(methods.agent.session.load, { sessionId: "nope", cwd: sandbox.directory, mcpServers: [] }))).code, -32002);
    assert.equal((await failure(first.connection.agent.request(methods.agent.session.load, { sessionId: "nope", cwd: "relative", mcpServers: [] }))).code, -32602);
  });

  it("advertises image and embedded-context prompts and loadSession", async () => {
    first = startHarness(sandbox, []);
    const init = (await first.initialize()) as { agentCapabilities: { loadSession: boolean; promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean } } };
    assert.deepEqual(init.agentCapabilities.promptCapabilities, { image: true, audio: false, embeddedContext: true });
    assert.equal(init.agentCapabilities.loadSession, true);
  });

  it("an image in the prompt reaches the model as an image file; the same picture twice is one file", async () => {
    let seen: unknown[] = [];
    first = startHarness(sandbox, (request) => {
      seen = request.messages.flatMap((message) => message.content.filter((part) => part.type === "image"));
      return { text: "I see it" };
    });
    const created = await first.start();
    const block = { type: "image" as const, data: PNG, mimeType: "image/png" };
    await first.connection.agent.request(methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "what is this?" }, block, block] });
    assert.equal(seen.length, 2);
    const [one, two] = seen as Array<{ ref: string; mediaType: string }>;
    assert.equal(one!.ref, two!.ref);
    assert.equal(one!.mediaType, "image/png");
    assert.ok(existsSync(one!.ref));
    assert.equal((await readFile(one!.ref)).toString("base64"), PNG);
  });

  it("an image alone is enough to run a turn; an unreadable image type becomes a note", async () => {
    let text = "";
    first = startHarness(sandbox, (request) => {
      text = JSON.stringify(request.messages);
      return { text: "ok" };
    });
    const created = await first.start();
    const response = await first.connection.agent.request(methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "image", data: "AAAA", mimeType: "image/tiff" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.match(text, /cannot be read/);
  });

  it("an embedded text resource and a file link reach the model", async () => {
    let seen = "";
    first = startHarness(sandbox, (request) => {
      seen = JSON.stringify(request.messages);
      return { text: "ok" };
    });
    const created = await first.start();
    await first.connection.agent.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "use these" }, { type: "resource", resource: { uri: "file:///w/notes.md", text: "REMEMBER-THIS" } }],
    });
    assert.match(seen, /Contents of file:\/\/\/w\/notes.md/);
    assert.match(seen, /REMEMBER-THIS/);
  });

  it("a stdio MCP server from session/new is started, its tools reach the model, and its env values are never logged", async () => {
    const marker = join(sandbox.directory, "marker.txt");
    let tools: string[] = [];
    first = startHarness(sandbox, (request) => {
      tools = request.tools.map((tool) => tool.name);
      return { text: "ok" };
    });
    await first.initialize();
    const created = await first.connection.agent.request(methods.agent.session.new, {
      cwd: sandbox.directory,
      mcpServers: [{ name: "stub", command: process.execPath, args: [new URL("./support/mcp-stub.mjs", import.meta.url).pathname], env: [{ name: "MARKER_FILE", value: marker }, { name: "SECRET_TOKEN", value: "super-secret-token-value" }] }],
    });
    await prompt(first, created.sessionId, "hi");
    assert.ok(existsSync(marker), "the server was started");
    assert.match(await readFile(marker, "utf8"), /token of 24 characters/);
    assert.ok(tools.includes("mcp__stub__ping"), tools.join(","));
    assert.ok(!first.logs.join("").includes("super-secret-token-value"));
    await sleep(10);
  });

  it("an HTTP MCP server is left out with a warning, not an error, and its headers are not logged", async () => {
    first = startHarness(sandbox, [{ text: "ok" }]);
    await first.initialize();
    const created = await first.connection.agent.request(methods.agent.session.new, {
      cwd: sandbox.directory,
      mcpServers: [{ type: "http", name: "remote", url: "https://example.invalid/mcp", headers: [{ name: "Authorization", value: "Bearer super-secret-header" }] }],
    });
    assert.ok(created.sessionId);
    assert.ok(first.logs.join("").includes("left out"));
    assert.ok(!first.logs.join("").includes("super-secret-header"));
  });

  describe("@ references", () => {
    const lastMessage = (script: { value: string }) => (request: { messages: Array<{ content: unknown }> }) => {
      script.value = JSON.stringify(request.messages.at(-1)!.content);
      return { text: "ok" };
    };

    it("a file link from the client is named to the agent, like @path in the terminal", async () => {
      await writeFile(join(sandbox.directory, "notes.md"), "hello");
      const seen = { value: "" };
      first = startHarness(sandbox, lastMessage(seen));
      const created = await first.start();
      await first.connection.agent.request(methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "summarise" }, { type: "resource_link", uri: `file://${join(sandbox.directory, "notes.md")}`, name: "notes.md" }] });
      assert.match(seen.value, /look at them as needed/);
      assert.match(seen.value, new RegExp(`- ${join(sandbox.directory, "notes.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    });

    it("a typed @path that exists is named, relative to the session directory; one that does not exist is left alone", async () => {
      await writeFile(join(sandbox.directory, "notes.md"), "hello");
      const seen = { value: "" };
      first = startHarness(sandbox, lastMessage(seen));
      const created = await first.start();
      await prompt(first, created.sessionId, "read @notes.md and @missing.md");
      assert.match(seen.value, new RegExp(`- ${join(sandbox.directory, "notes.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(seen.value, /missing\.md\\n-|- .*missing\.md/);
    });

    it("a link to a picture attaches the picture", async () => {
      await writeFile(join(sandbox.directory, "pic.png"), Buffer.from(PNG, "base64"));
      let image: { type: string; ref?: string; mediaType?: string } | undefined;
      first = startHarness(sandbox, (request) => {
        image = (request.messages.at(-1)!.content as Array<{ type: string; ref?: string; mediaType?: string }>).find((part) => part.type === "image");
        return { text: "ok" };
      });
      const created = await first.start();
      await first.connection.agent.request(methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "what is" }, { type: "resource_link", uri: `file://${join(sandbox.directory, "pic.png")}`, name: "pic.png" }] });
      assert.equal(image?.ref, join(sandbox.directory, "pic.png"));
      assert.equal(image?.mediaType, "image/png");
    });
  });
});
