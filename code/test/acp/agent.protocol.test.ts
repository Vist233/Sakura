import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { methods, RequestError } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ProviderError } from "../../src/framework.ts";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const kinds = (updates: SessionNotification[]) => updates.map((item) => item.update.sessionUpdate);
const textOf = (updates: SessionNotification[], kind: string) =>
  updates
    .filter((item) => item.update.sessionUpdate === kind)
    .map((item) => {
      const content = (item.update as { content: { type: string; text?: string } }).content;
      return content.type === "text" ? content.text : "";
    })
    .join("");
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

describe("ACP agent over the SDK client (L2)", () => {
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

  it("initialize answers with a valid response: protocol version 1, capabilities, no auth methods, agent info", async () => {
    harness = startHarness(sandbox, []);
    const response = (await harness.initialize()) as { protocolVersion: number; agentInfo: { name: string; version: string }; authMethods: unknown[]; agentCapabilities: { loadSession: boolean } };
    assert.equal(response.protocolVersion, 1);
    assert.equal(response.agentInfo.name, "sakuracode");
    assert.equal(response.agentInfo.version, "9.9.9");
    assert.deepEqual(response.authMethods, []);
    assert.equal(response.agentCapabilities.loadSession, false);
  });

  it("authenticate exists and answers", async () => {
    harness = startHarness(sandbox, []);
    await harness.initialize();
    assert.deepEqual(await harness.connection.agent.request(methods.agent.authenticate, { methodId: "none" }), {});
  });

  it("streams a reply as agent_message_chunk updates and ends the turn", async () => {
    harness = startHarness(sandbox, [{ text: "Hello from the scripted model", chunkSize: 6 }]);
    const { sessionId } = await harness.start();
    const response = await prompt(harness, sessionId, "say hello");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(textOf(harness.updates, "agent_message_chunk"), "Hello from the scripted model");
    assert.ok(harness.updates.every((item) => item.sessionId === sessionId));
    const ids = new Set(harness.updates.map((item) => (item.update as { messageId?: string }).messageId));
    assert.equal(ids.size, 1, "one reply, one message id");
    assert.ok([...ids][0]);
  });

  it("streams reasoning as agent_thought_chunk updates", async () => {
    harness = startHarness(sandbox, [{ reasoning: "Let me think.", text: "Done." }]);
    const { sessionId } = await harness.start();
    await prompt(harness, sessionId, "think");
    assert.equal(textOf(harness.updates, "agent_thought_chunk"), "Let me think.");
    assert.equal(textOf(harness.updates, "agent_message_chunk"), "Done.");
  });

  it("a reply that is sent again after a dropped connection gets a new message id and keeps the text already sent", async () => {
    harness = startHarness(sandbox, [{ droppedFirst: "Partial", text: "Whole reply" }]);
    const { sessionId } = await harness.start();
    await prompt(harness, sessionId, "go");
    const messages = harness.updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk");
    assert.equal(textOf(harness.updates, "agent_message_chunk"), "PartialWhole reply");
    assert.notEqual((messages[0]!.update as { messageId: string }).messageId, (messages.at(-1)!.update as { messageId: string }).messageId);
  });

  it("no update arrives after the prompt response", async () => {
    harness = startHarness(sandbox, [{ text: "short" }]);
    const { sessionId } = await harness.start();
    await prompt(harness, sessionId, "go");
    const count = harness.updates.length;
    await sleep(80);
    assert.equal(harness.updates.length, count);
  });

  it("session/cancel ends a running turn with stop reason cancelled", async () => {
    harness = startHarness(sandbox, [{ hang: true }]);
    const { sessionId } = await harness.start();
    const running = prompt(harness, sessionId, "wait forever");
    await sleep(100);
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    assert.equal((await running).stopReason, "cancelled");
    const count = harness.updates.length;
    await sleep(80);
    assert.equal(harness.updates.length, count, "nothing after the response");
  });

  it("$/cancel_request for a running prompt stops the turn, so the session is free for the next prompt", async () => {
    harness = startHarness(sandbox, [{ hang: true }, { text: "next" }]);
    const { sessionId } = await harness.start();
    const abort = new AbortController();
    const running = harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "wait" }] }, { cancellationSignal: abort.signal }).catch(() => undefined);
    await sleep(100);
    abort.abort();
    await running;
    let freed = false;
    for (let attempt = 0; attempt < 30 && !freed; attempt++) {
      await sleep(50);
      freed = !(await prompt(harness, sessionId, "again").then(() => false, (error: RequestError) => error.code === -32001));
    }
    assert.ok(freed, "the session stayed busy after $/cancel_request");
  });

  it("cancelling an idle session or an unknown one is harmless, and the session still works", async () => {
    harness = startHarness(sandbox, [{ text: "still here" }]);
    const { sessionId } = await harness.start();
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId: "nope" });
    assert.equal((await prompt(harness, sessionId, "hi")).stopReason, "end_turn");
  });

  it("a second prompt while one runs is answered with a busy error; the first one is not disturbed", async () => {
    harness = startHarness(sandbox, [{ hang: true }]);
    const { sessionId } = await harness.start();
    const first = prompt(harness, sessionId, "first");
    await sleep(100);
    const error = await failure(prompt(harness, sessionId, "second"));
    assert.equal(error.code, -32001);
    assert.match(error.message, /already running/);
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    assert.equal((await first).stopReason, "cancelled");
  });

  it("sessions are independent: one turn per session, several sessions at once", async () => {
    harness = startHarness(sandbox, (_request, index) => (index === 0 ? { hang: true } : { text: "second session reply" }));
    const a = await harness.start();
    const b = await harness.connection.agent.request(methods.agent.session.new, { cwd: harness.directory, mcpServers: [] });
    assert.notEqual(a.sessionId, b.sessionId);
    const first = prompt(harness, a.sessionId, "hang");
    await sleep(100);
    assert.equal((await prompt(harness, b.sessionId, "go")).stopReason, "end_turn");
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId: a.sessionId });
    assert.equal((await first).stopReason, "cancelled");
  });

  it("an unknown session id is a session-not-found error", async () => {
    harness = startHarness(sandbox, []);
    await harness.start();
    const error = await failure(prompt(harness, "no-such-session", "hi"));
    assert.equal(error.code, -32002);
  });

  it("a relative cwd is an invalid-params error", async () => {
    harness = startHarness(sandbox, []);
    await harness.initialize();
    const error = await failure(harness.connection.agent.request(methods.agent.session.new, { cwd: "relative/path", mcpServers: [] }));
    assert.equal(error.code, -32602);
  });

  it("an empty prompt ends the turn at once", async () => {
    harness = startHarness(sandbox, []);
    const { sessionId } = await harness.start();
    const response = await harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "   " }] });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(harness.updates.length, 0);
  });

  it("a failing provider is a JSON-RPC error that names the failure and the session still works afterwards", async () => {
    harness = startHarness(sandbox, [{ error: new ProviderError("invalid_request", "upstream exploded") }, { text: "recovered" }]);
    const { sessionId } = await harness.start();
    const error = await failure(prompt(harness, sessionId, "go"));
    assert.equal(error.code, -32603);
    assert.match(error.message, /upstream exploded/);
    assert.equal((await prompt(harness, sessionId, "again")).stopReason, "end_turn");
    assert.equal(textOf(harness.updates, "agent_message_chunk"), "recovered");
  });

  it("an error text never carries a credential", async () => {
    harness = startHarness(sandbox, [{ error: new ProviderError("invalid_request", "401 with Authorization: Bearer sk-abcdefghijklmnop1234") }]);
    const { sessionId } = await harness.start();
    const error = await failure(prompt(harness, sessionId, "go"));
    assert.match(error.message, /401/, "the failure is still described");
    assert.ok(!/sk-abcdefghijklmnop1234/.test(error.message), error.message);
    assert.ok(!harness.logs.join("").includes("sk-abcdefghijklmnop1234"));
  });

  it("a non-text block is not an error; the model is told something was sent", async () => {
    harness = startHarness(sandbox, (request) => ({ text: JSON.stringify(request.messages).includes("not supported yet") ? "noted" : "missed" }));
    const { sessionId } = await harness.start();
    const response = await harness.connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    assert.equal(response.stopReason, "end_turn");
    assert.equal(textOf(harness.updates, "agent_message_chunk"), "noted");
  });

  it("an unknown method is method-not-found", async () => {
    harness = startHarness(sandbox, []);
    await harness.initialize();
    const error = await failure(harness.connection.agent.request("session/does_not_exist", {}));
    assert.equal(error.code, -32601);
  });

  it("without a provider key, session/new asks for authentication and says which variable to set", async () => {
    harness = startHarness(sandbox, [], { noClients: true, env: {} });
    await harness.initialize();
    const error = await failure(harness.connection.agent.request(methods.agent.session.new, { cwd: harness.directory, mcpServers: [] }));
    assert.equal(error.code, -32000);
    assert.match(error.message, /DEEPSEEK_API_KEY|OPENCODE_API_KEY/);
  });

  it("stop cancels a running turn and closes cleanly", async () => {
    harness = startHarness(sandbox, [{ hang: true }]);
    const { sessionId } = await harness.start();
    const running = prompt(harness, sessionId, "hang").catch(() => undefined);
    await sleep(100);
    assert.equal(await harness.stop(), 0);
    await running;
  });

  it("uses the review mode it was given for new sessions", async () => {
    harness = startHarness(sandbox, [{ text: "x" }], { permissions: "strict" });
    const { sessionId } = await harness.start();
    assert.ok(sessionId.length > 0);
    assert.ok(harness.logs.some((line) => line.includes('"permissions":"strict"')), harness.logs.join(""));
  });
});
