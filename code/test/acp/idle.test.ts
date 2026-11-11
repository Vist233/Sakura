import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { methods } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createIdleCompactor } from "../../src/acp/idle.ts";
import { createLogger } from "../../src/acp/log.ts";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TTL = 0.0015; // minutes: 90 ms

describe("idle compactor (L1, with fake sessions)", () => {
  const make = (overrides: { enabled?: boolean; busy?: () => boolean; result?: { before: number; after: number } | undefined } = {}) => {
    const calls: Array<[string, number]> = [];
    const told: string[] = [];
    const compactor = createIdleCompactor({
      settings: { autoCompactIdle: overrides.enabled ?? true, cacheTtlMinutes: TTL, autoCompactMinTokens: 5000 },
      sessions: {
        busy: overrides.busy ?? (() => false),
        compactIdle: async (id, min) => {
          calls.push([id, min]);
          return "result" in overrides ? overrides.result : { before: 9000, after: 1000 };
        },
      },
      compacted: async (id) => void told.push(id),
      log: createLogger(() => undefined, "off"),
    });
    return { compactor, calls, told };
  };

  it("compacts a session once it has been idle for the cache lifetime, with the configured minimum", async () => {
    const { compactor, calls, told } = make();
    compactor.touch("s1");
    await sleep(40);
    assert.equal(calls.length, 0, "not before the time");
    await sleep(120);
    assert.deepEqual(calls, [["s1", 5000]]);
    assert.deepEqual(told, ["s1"]);
    compactor.stop();
  });

  it("every touch starts the wait again", async () => {
    const { compactor, calls } = make();
    for (let step = 0; step < 4; step++) {
      compactor.touch("s1");
      await sleep(50);
    }
    assert.equal(calls.length, 0);
    compactor.stop();
  });

  it("waits and tries again while the session is busy", async () => {
    let busy = true;
    const { compactor, calls } = make({ busy: () => busy });
    compactor.touch("s1");
    await sleep(250);
    assert.equal(calls.length, 0);
    busy = false;
    await sleep(250);
    assert.equal(calls.length, 1);
    compactor.stop();
  });

  it("says nothing to the client when there was nothing to compact", async () => {
    const { compactor, calls, told } = make({ result: undefined });
    compactor.touch("s1");
    await sleep(200);
    assert.equal(calls.length, 1);
    assert.deepEqual(told, []);
    compactor.stop();
  });

  it("does nothing when idle compaction is off, and stop cancels what is waiting", async () => {
    const off = make({ enabled: false });
    off.compactor.touch("s1");
    const on = make();
    on.compactor.touch("s1");
    on.compactor.stop();
    await sleep(200);
    assert.equal(off.calls.length, 0);
    assert.equal(on.calls.length, 0);
  });

  it("each session has its own wait", async () => {
    const { compactor, calls } = make();
    compactor.touch("a");
    await sleep(60);
    compactor.touch("b");
    await sleep(60);
    assert.deepEqual(calls.map(([id]) => id), ["a"]);
    await sleep(100);
    assert.deepEqual(calls.map(([id]) => id), ["a", "b"]);
    compactor.stop();
  });
});

describe("idle compaction over the SDK client (L2)", () => {
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
  const compactions = () => harness!.logs.filter((line) => line.includes("compacted after idle")).length;
  const settings = (overrides: { minTokens?: number; enabled?: boolean } = {}) => ({ settings: { cacheTtlMinutes: TTL, autoCompactMinTokens: overrides.minTokens ?? 1000, autoCompactIdle: overrides.enabled ?? true } });
  const long = (word: string) => `${word} ${"word ".repeat(3000)}`;
  const prompt = (sessionId: string, text: string) => harness!.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
  const kinds = (list: SessionNotification[]) => list.map((item) => item.update.sessionUpdate);

  it("compacts an idle session in the background, sends only a usage_update, and the session goes on working", async () => {
    harness = startHarness(sandbox, (_request, index) => ({ text: `reply ${index}` }), settings({ minTokens: 5000 }));
    const { sessionId } = await harness.start();
    await prompt(sessionId, long("first"));
    await prompt(sessionId, long("second"));
    const before = harness.updates.length;
    assert.equal(compactions(), 0);
    await sleep(600);
    assert.equal(compactions(), 1, "compacted once");
    const meter = harness.updates.slice(before);
    assert.deepEqual(kinds(meter), ["usage_update"], "nothing for the person to read");
    const line = JSON.parse(harness.logs.find((entry) => entry.includes("compacted after idle"))!) as { tokensBefore: number; tokensAfter: number };
    assert.ok(line.tokensAfter < line.tokensBefore, `${line.tokensBefore} to ${line.tokensAfter}`);
    assert.ok((meter[0]!.update as { used: number }).used <= line.tokensBefore);
    assert.equal((await prompt(sessionId, "and now?")).stopReason, "end_turn");
    await sleep(300);
    assert.equal(compactions(), 1, "a small context is not compacted again");
  });

  it("leaves a small conversation alone", async () => {
    harness = startHarness(sandbox, [{ text: "hi" }], settings({ minTokens: 20_000 }));
    const { sessionId } = await harness.start();
    await prompt(sessionId, "hello");
    await sleep(400);
    assert.equal(compactions(), 0);
  });

  it("does nothing when idle compaction is off", async () => {
    harness = startHarness(sandbox, (_request, index) => ({ text: `reply ${index}` }), settings({ enabled: false }));
    const { sessionId } = await harness.start();
    await prompt(sessionId, long("first"));
    await prompt(sessionId, long("second"));
    await sleep(400);
    assert.equal(compactions(), 0);
  });

  it("does not compact while a turn is running", async () => {
    harness = startHarness(sandbox, (_request, index) => (index === 1 ? { hang: true } : { text: `reply ${index}` }), settings());
    const { sessionId } = await harness.start();
    await prompt(sessionId, long("first"));
    const running = prompt(sessionId, long("second"));
    await sleep(400);
    assert.equal(compactions(), 0, "the long turn was not interrupted by the timer");
    await harness.connection.agent.notify(methods.agent.session.cancel, { sessionId });
    await running;
  });
});
