// Scheduled jobs over the SDK client (L2): a due job runs as a turn and its updates arrive outside any prompt request (experimental), marked as
// scheduled, and a later session/load restores the jobs and replays those turns as ordinary messages.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { methods } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { DEFAULT_SCHEDULE } from "../../src/config.ts";
import { fakeClock } from "../support/fake-clock.ts";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const MIN = 60_000;
type Update = SessionNotification["update"] & Record<string, unknown>;
const prompt = (harness: Harness, sessionId: string, text: string) => harness.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
const texts = (list: SessionNotification[], kind: string) => list.filter((item) => item.update.sessionUpdate === kind).map((item) => (item.update as Update & { content: { text: string } }).content.text);
const said = (list: SessionNotification[]) => texts(list, "agent_message_chunk").join("");

async function until(check: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 400; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("scheduled jobs over ACP (L2)", () => {
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

  it("/loop adds a job; when due the turn streams outside a prompt, marked as scheduled, and /status shows the job", async () => {
    const clock = fakeClock();
    first = startHarness(sandbox, (_request, index) => ({ text: `pong ${index}` }), { clock });
    const { sessionId } = await first.start();
    assert.equal((await prompt(first, sessionId, "/loop 1m ping")).stopReason, "end_turn");
    assert.match(said(first.updates), /Scheduled job 1: every 1m/);
    const before = first.updates.length;
    // no request is open now: whatever arrives from here on is outside a prompt
    await clock.advance(MIN);
    await until(() => said(first!.updates.slice(before)).includes("pong 0"), "the scheduled turn");
    const arrived = first.updates.slice(before);
    const user = arrived.find((item) => item.update.sessionUpdate === "user_message_chunk")!;
    assert.equal((user.update as Update & { content: { text: string } }).content.text, "[scheduled task] ping");
    assert.deepEqual((user.update as Update & { _meta?: unknown })._meta, { sakuracode: { scheduled: { id: "1", kind: "interval" } } });
    assert.ok(arrived.every((item) => item.sessionId === sessionId));
    const order = arrived.map((item) => item.update.sessionUpdate);
    assert.ok(order.indexOf("user_message_chunk") < order.indexOf("agent_message_chunk"));
    const mark = first.updates.length;
    await prompt(first, sessionId, "/status");
    assert.match(said(first.updates.slice(mark)), /\*\*Scheduled\*\* \| 1 job, next at \d\d:\d\d: ping/);
    await prompt(first, sessionId, "/loop stop");
  });

  it("session/load restores the jobs, replays the scheduled turns as ordinary messages, and a time missed in between fires once", async () => {
    const clock = fakeClock();
    first = startHarness(sandbox, (_request, index) => ({ text: `pong ${index}` }), { clock });
    const { sessionId } = await first.start();
    await prompt(first, sessionId, "/loop 5m ping");
    await clock.advance(5 * MIN);
    await until(() => said(first!.updates).includes("pong 0"), "the scheduled turn");
    await until(() => !first!.logs.some((line) => line.includes("error")) && first!.updates.some((item) => item.update.sessionUpdate === "usage_update"), "the end of the turn");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.stop();

    const later = fakeClock(clock.now() + 3_600_000);
    second = startHarness(sandbox, (_request, index) => ({ text: `again ${index}` }), { clock: later });
    await second.initialize();
    await second.connection.agent.request(methods.agent.session.load, { sessionId, cwd: sandbox.directory, mcpServers: [] });
    assert.deepEqual(texts(second.updates, "user_message_chunk"), ["[scheduled task] ping"]);
    assert.deepEqual((second.updates.find((item) => item.update.sessionUpdate === "user_message_chunk")!.update as Update & { _meta?: unknown })._meta, undefined);
    assert.equal(said(second.updates), "pong 0");
    const mark = second.updates.length;
    await prompt(second, sessionId, "/loop");
    assert.match(said(second.updates.slice(mark)), /\| 1 \| every 5m \| ping \|/);
    await later.advance(3000);
    await until(() => said(second!.updates).includes("again 0"), "the catch-up turn");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await later.advance(4 * MIN);
    assert.equal(texts(second.updates, "user_message_chunk").filter((text) => text === "[scheduled task] ping").length, 2, "one replayed, one fired, none per missed interval");
  });

  it("the agent's own schedule_wakeup wakes it with the reason", async () => {
    const clock = fakeClock();
    first = startHarness(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "schedule_wakeup", id: "w1", args: { minutes: 5, reason: "look at the deploy" } }] } : index === 1 ? { text: "waiting" } : { text: "deploy is fine" }), { clock, permissions: "full-access" });
    const { sessionId } = await first.start();
    await prompt(first, sessionId, "deploy it");
    const mark = first.updates.length;
    await clock.advance(5 * MIN);
    await until(() => said(first!.updates.slice(mark)).includes("deploy is fine"), "the wake-up turn");
    assert.deepEqual(texts(first.updates.slice(mark), "user_message_chunk"), ["[wake-up you asked for] look at the deploy"]);
    assert.deepEqual((first.updates.slice(mark).find((item) => item.update.sessionUpdate === "user_message_chunk")!.update as Update & { _meta?: unknown })._meta, { sakuracode: { scheduled: { id: "1", kind: "wakeup" } } });
  });

  it("a prompt that arrives during a scheduled turn waits for it, then runs", async () => {
    const clock = fakeClock();
    first = startHarness(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "bash", id: "b1", args: { command: "sleep 0.4" } }] } : { text: `reply ${index}` }), { clock, permissions: "full-access" });
    const { sessionId } = await first.start();
    await prompt(first, sessionId, "/in 1m slow job");
    await clock.advance(MIN);
    await until(() => first!.updates.some((item) => item.update.sessionUpdate === "tool_call"), "the scheduled turn running");
    const answer = await prompt(first, sessionId, "now me");
    assert.equal(answer.stopReason, "end_turn");
    const users = texts(first.updates, "user_message_chunk");
    assert.deepEqual(users, ["[scheduled task] slow job"]);
    assert.match(said(first.updates), /reply 2/, "the second turn answered after the first");
  });

  it("tells the client when a job stops itself", async () => {
    const clock = fakeClock();
    first = startHarness(sandbox, [{ text: "ok" }], { clock, settings: { schedule: { ...DEFAULT_SCHEDULE, maxRuns: 1 } } });
    const { sessionId } = await first.start();
    await prompt(first, sessionId, "/loop 1m once more");
    await clock.advance(MIN);
    await until(() => said(first!.updates).includes("stopped after 1 runs"), "the stop message");
  });

  it("is refused politely when turned off", async () => {
    first = startHarness(sandbox, [], { settings: { schedule: { ...DEFAULT_SCHEDULE, enabled: false } } });
    const { sessionId } = await first.start();
    await prompt(first, sessionId, "/loop 1m x");
    assert.match(said(first.updates), /turned off/);
  });
});
