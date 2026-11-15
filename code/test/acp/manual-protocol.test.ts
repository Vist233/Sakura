import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { methods } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { makeSandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const cancelled = { outcome: { outcome: "cancelled" } } as const;
const prompt = (harness: Harness, sessionId: string, text: string) =>
  harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
const manual = (harness: Harness, sessionId: string) =>
  harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "mode", value: "manual" });

it("manual approval waits, honors rejection, and requires approval again for identical arguments", async () => {
  const sandbox = await makeSandbox();
  const marker = join(sandbox.directory, "marker");
  const command = "echo approved >> marker";
  let decide!: (answer: RequestPermissionResponse) => void;
  let requested!: (request: RequestPermissionRequest) => void;
  const first = new Promise<RequestPermissionRequest>((resolve) => { requested = resolve; });
  const held = new Promise<RequestPermissionResponse>((resolve) => { decide = resolve; });
  let calls = 0;
  const client = startHarness(sandbox, [
    { toolCalls: [{ name: "bash", id: "one", args: { command } }, { name: "bash", id: "two", args: { command } }] },
    { text: "done" },
  ], {
    approve: async (request) => {
      if (++calls === 1) {
        requested(request);
        return held;
      }
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    },
  });
  try {
    const { sessionId } = await client.start();
    await manual(client, sessionId);
    const running = prompt(client, sessionId, "run both");
    const request = await first;
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.toolCall.toolCallId, "one");
    assert.deepEqual(request.toolCall.rawInput, { command });
    assert.deepEqual(request.options.map(({ kind }) => kind), ["allow_once", "reject_once"]);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    decide({ outcome: { outcome: "selected", optionId: "reject" } });
    assert.equal((await running).stopReason, "end_turn");
    assert.equal(calls, 2);
    assert.equal(await readFile(marker, "utf8"), "approved\n");
  } finally {
    decide(cancelled);
    await client.stop();
    await sandbox.cleanup();
  }
});

it("cancels a pending permission request and does not execute its command", async () => {
  const sandbox = await makeSandbox();
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => { requested = resolve; });
  let permissionAborted = false;
  const client = startHarness(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "touch cancelled-marker" } }] }], {
    permissions: "manual",
    approve: async (_request, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { permissionAborted = true; resolve(cancelled); }, { once: true });
      requested();
    }),
  });
  try {
    const { sessionId } = await client.start();
    const running = prompt(client, sessionId, "cancel this");
    await pending;
    await client.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    assert.equal((await running).stopReason, "cancelled");
    assert.ok(permissionAborted);
    await assert.rejects(readFile(join(sandbox.directory, "cancelled-marker")), { code: "ENOENT" });
  } finally {
    await client.stop();
    await sandbox.cleanup();
  }
});

it("lists by directory and resumes without replaying the transcript or losing manual mode", async () => {
  const sandbox = await makeSandbox();
  const first = startHarness(sandbox, [{ text: "secret-context-test" }]);
  const second = startHarness(sandbox, (request) => ({ text: request.messages.some((message) => message.content.some((part) => part.type === "text" && part.text === "secret-context-test")) ? "retained" : "missing" }));
  try {
    const { sessionId } = await first.start();
    await manual(first, sessionId);
    await prompt(first, sessionId, "conversation title");
    await first.stop();
    const init = await second.initialize() as { agentCapabilities: { sessionCapabilities: unknown } };
    assert.deepEqual(init.agentCapabilities.sessionCapabilities, { list: {}, resume: {} });
    const list = await second.connection.agent.request(methods.agent.session.list, { cwd: sandbox.directory });
    assert.deepEqual(list.sessions.map(({ sessionId, title }) => ({ sessionId, title })), [{ sessionId, title: "conversation title" }]);
    const elsewhere = await second.connection.agent.request(methods.agent.session.list, { cwd: join(sandbox.directory, "elsewhere") });
    assert.deepEqual(elsewhere.sessions, []);
    const resumed = await second.connection.agent.request(methods.agent.session.resume, { cwd: sandbox.directory, sessionId });
    assert.equal(resumed?.configOptions?.find(({ id }) => id === "mode")?.currentValue, "manual");
    assert.ok(!second.updates.some(({ update }) => update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk"));
    assert.equal((await prompt(second, sessionId, "continue")).stopReason, "end_turn");
    assert.ok(second.updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text === "retained"));
  } finally {
    await first.stop();
    await second.stop();
    await sandbox.cleanup();
  }
});
