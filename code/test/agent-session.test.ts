import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openAgentSession } from "../src/agent-session.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { createRunDriver } from "../src/run-driver.ts";
import { createTranscript } from "../src/transcript.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";
import { scriptedClient } from "./support/scripted-client.ts";

// a made-up token in the shape of a GitHub personal access token; it is not a real credential
const FAKE_TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}`;

describe("agent session", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  const open = (client: ReturnType<typeof scriptedClient>, redaction: boolean, name: string) =>
    openAgentSession({ settings: DEFAULT_SETTINGS, provider: "scripted", sessionId: name, sessionFile: join(sandbox.directory, `${name}.jsonl`), cwd: sandbox.directory, permissions: "full-access", redaction, env: {}, clients: { agent: client } });

  it("redaction is off by default: the model sees the text as typed", async () => {
    const client = scriptedClient([{ text: "ok" }]);
    const session = await open(client, false, "plain");
    await createRunDriver(createTranscript()).run(session.agent, `my token is ${FAKE_TOKEN}`);
    assert.ok(JSON.stringify(client.requests[0]!.messages).includes(FAKE_TOKEN));
    await session.close();
  });

  it("redaction can be turned on: the model sees a placeholder instead of the secret", async () => {
    const client = scriptedClient([{ text: "ok" }]);
    const session = await open(client, true, "masked");
    await createRunDriver(createTranscript()).run(session.agent, `my token is ${FAKE_TOKEN}`);
    const sent = JSON.stringify(client.requests[0]!.messages);
    assert.ok(!sent.includes(FAKE_TOKEN));
    assert.match(sent, /\{\{[A-Z_]+_[0-9a-f]+\}\}/);
    await session.close();
  });

  it("asks for Markdown replies in the system prompt and gives the agent no directory restriction", async () => {
    const client = scriptedClient([{ text: "ok" }]);
    const session = await open(client, false, "prompt");
    await createRunDriver(createTranscript()).run(session.agent, "hi");
    assert.match(client.requests[0]!.system, /Write your replies in Markdown/);
    assert.ok(client.requests[0]!.tools.map((tool) => tool.name).sort().join() === "bash,edit,read,write");
    await session.close();
  });

  it("read-only exposes only the read tool", async () => {
    const client = scriptedClient([{ text: "ok" }]);
    const session = await openAgentSession({ settings: DEFAULT_SETTINGS, provider: "scripted", sessionId: "ro", sessionFile: join(sandbox.directory, "ro.jsonl"), cwd: sandbox.directory, permissions: "read-only", redaction: false, env: {}, clients: { agent: client, reviewer: scriptedClient([]) } });
    await createRunDriver(createTranscript()).run(session.agent, "hi");
    assert.deepEqual(client.requests[0]!.tools.map((tool) => tool.name), ["read"]);
    await session.close();
  });
});
