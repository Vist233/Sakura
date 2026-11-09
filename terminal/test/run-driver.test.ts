import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRunDriver } from "../src/run-driver.ts";
import { createTranscript } from "../src/transcript.ts";
import type { Event } from "../src/framework.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { makeSandbox, openScripted } from "./support/harness.ts";
import { scriptedClient } from "./support/scripted-client.ts";
import type { Sandbox } from "./support/harness.ts";

describe("run driver", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  it("runs a prompt, fills the transcript and forwards raw events", async () => {
    const { session } = await openScripted(sandbox, [{ text: "Hello **there**." }]);
    const transcript = createTranscript();
    const driver = createRunDriver(transcript);
    const types: string[] = [];
    driver.onEvent((event: Event) => types.push(event.type));
    const outcome = await driver.run(session.agent, "hi");
    assert.equal(outcome.result.reason, "done");
    assert.deepEqual(transcript.blocks().map((block) => block.kind), ["user", "assistant"]);
    assert.ok(types.includes("run_start") && types.includes("run_end"));
    assert.equal(driver.working, false);
    await session.close();
  });

  it("shows a tool call with its real result", async () => {
    const { session } = await openScripted(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "echo hello-from-tool" } }] }, { text: "done" }]);
    const transcript = createTranscript();
    await createRunDriver(transcript).run(session.agent, "go");
    const tool = transcript.blocks().find((block) => block.kind === "tool");
    assert.ok(tool?.kind === "tool");
    assert.equal(tool.status, "ok");
    assert.ok(tool.output.join("\n").includes("hello-from-tool"));
    await session.close();
  });

  it("a failing command shows as failed with the real exit code, not exit=0", async () => {
    const { session } = await openScripted(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "echo oops; exit 7" } }] }, { text: "it failed" }]);
    const transcript = createTranscript();
    await createRunDriver(transcript).run(session.agent, "go");
    const tool = transcript.blocks().find((block) => block.kind === "tool");
    assert.ok(tool?.kind === "tool");
    assert.equal(tool.status, "error");
    assert.equal(tool.exitCode, 7);
    await session.close();
  });

  it("delivers a steering message before the next request and shows it", async () => {
    const { session, client } = await openScripted(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "bash", args: { command: "sleep 0.3" } }] } : { text: "ok" }));
    const transcript = createTranscript();
    const driver = createRunDriver(transcript);
    const running = driver.run(session.agent, "start");
    await new Promise((resolve) => setTimeout(resolve, 100));
    driver.steer("actually do it differently");
    assert.deepEqual(driver.pending(), [{ kind: "steer", text: "actually do it differently" }]);
    const outcome = await running;
    assert.equal(outcome.leftover.length, 0);
    assert.equal(driver.pending().length, 0);
    const last = client.requests.at(-1)!;
    assert.ok(JSON.stringify(last.messages).includes("actually do it differently"));
    assert.ok(transcript.blocks().some((block) => block.kind === "user" && block.text === "actually do it differently"));
    await session.close();
  });

  it("runs a queued message when the agent would stop", async () => {
    const { session, client } = await openScripted(sandbox, (_request, index) => (index === 0 ? { delayMs: 150, text: "first" } : { text: "second" }));
    const transcript = createTranscript();
    const driver = createRunDriver(transcript);
    const running = driver.run(session.agent, "one");
    await new Promise((resolve) => setTimeout(resolve, 30));
    driver.queue("two");
    const outcome = await running;
    assert.equal(outcome.leftover.length, 0);
    assert.equal(client.requests.length, 2);
    assert.deepEqual(transcript.blocks().filter((block) => block.kind === "assistant").map((block) => (block.kind === "assistant" ? block.text : "")), ["first", "second"]);
    await session.close();
  });

  it("cancels a run and reports it", async () => {
    const { session } = await openScripted(sandbox, [{ hang: true }]);
    const transcript = createTranscript();
    const driver = createRunDriver(transcript);
    const running = driver.run(session.agent, "wait");
    await new Promise((resolve) => setTimeout(resolve, 50));
    driver.cancel();
    const outcome = await running;
    assert.equal(outcome.result.reason, "cancelled");
    assert.ok(transcript.blocks().some((block) => block.kind === "notice" && block.text === "Run cancelled."));
    await session.close();
  });

  it("ignores steer and queue when nothing is running", async () => {
    const { session } = await openScripted(sandbox, [{ text: "x" }]);
    const driver = createRunDriver(createTranscript());
    driver.steer("a");
    driver.queue("b");
    assert.deepEqual(driver.pending(), []);
    await session.close();
  });

  it("with review on, a refused call is shown as denied with the reviewer's reason and does not run", async () => {
    const reviewer = scriptedClient([{ text: '{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"writes where the user did not ask"}' }]);
    const { session } = await openScripted(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "echo secret > leaked.txt" } }] }, { text: "I was not allowed to do that." }], { permissions: "auto", reviewer });
    const transcript = createTranscript();
    await createRunDriver(transcript).run(session.agent, "write a file");
    const tool = transcript.blocks().find((block) => block.kind === "tool");
    assert.ok(tool?.kind === "tool");
    assert.equal(tool.status, "denied");
    assert.equal(tool.review?.decidedBy, "reviewer");
    assert.match(tool.review?.reason ?? "", /writes where the user did not ask/);
    await assert.rejects(() => access(join(sandbox.directory, "leaked.txt")));
    await session.close();
  });

  it("with review on, a read-only command in the directory is allowed by the hard rules without asking the reviewer", async () => {
    const reviewer = scriptedClient([]);
    const { session } = await openScripted(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }, { text: "listed" }], { permissions: "auto", reviewer });
    const transcript = createTranscript();
    await createRunDriver(transcript).run(session.agent, "list");
    const tool = transcript.blocks().find((block) => block.kind === "tool");
    assert.ok(tool?.kind === "tool" && tool.status === "ok");
    assert.equal(reviewer.requests.length, 0);
    await session.close();
  });
});
