// Scheduled prompts in the terminal's controller, driven by a scripted model and a clock moved by hand.
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { readScheduleState } from "../src/schedule.ts";
import { createController } from "../src/session-controller.ts";
import type { Controller, Surface } from "../src/session-controller.ts";
import { createSessionStore } from "../src/session-store.ts";
import type { SessionStore } from "../src/session-store.ts";
import { createTranscript } from "../src/transcript.ts";
import type { Block, Transcript } from "../src/transcript.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";
import { fakeClock } from "./support/fake-clock.ts";
import type { FakeClock } from "./support/fake-clock.ts";
import { scriptedClient } from "./support/scripted-client.ts";
import type { Script } from "./support/scripted-client.ts";

const MIN = 60_000;

interface Rig {
  controller: Controller;
  transcript: Transcript;
  store: SessionStore;
  clock: FakeClock;
  typing: { value: boolean };
  texts(): string[];
}

function rig(sandbox: Sandbox, script: Script, options: { clock?: FakeClock; store?: SessionStore } = {}): Rig {
  const transcript = createTranscript();
  const store = options.store ?? createSessionStore(join(sandbox.directory, "sessions"));
  const clock = options.clock ?? fakeClock();
  const typing = { value: false };
  const surface: Surface = { changed: () => undefined, pickSession: async () => undefined, clearScreen: () => undefined, prefill: () => undefined, typing: () => typing.value, exit: () => undefined };
  const controller = createController({ settings: { ...DEFAULT_SETTINGS, permissions: "full-access" }, cwd: sandbox.directory, home: undefined, env: {}, store, transcript, surface, clients: { agent: scriptedClient(script) }, clock });
  const texts = () => transcript.blocks().map((block: Block) => (block.kind === "assistant" ? `A:${block.text}` : block.kind === "user" ? `U:${block.text}` : block.kind === "notice" ? `N:${block.text}` : block.kind === "info" ? `I:${block.markdown}` : block.kind));
  return { controller, transcript, store, clock, typing, texts };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let index = 0; index < 400; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("scheduled prompts in the terminal", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  it("/loop runs the prompt as a turn when due and shows the indicator only while a job is active", async () => {
    const r = rig(sandbox, (_request, index) => ({ text: `pong ${index}` }));
    await r.controller.start();
    assert.equal(r.controller.statusInfo().scheduled, 0);
    await r.controller.submit("/loop 1m ping");
    assert.match(r.texts().at(-1)!, /Scheduled job 1: every 1m/);
    assert.equal(r.controller.statusInfo().scheduled, 1);
    await r.clock.advance(MIN);
    await until(() => r.texts().includes("A:pong 0"), "the scheduled turn");
    assert.ok(r.texts().includes("U:[scheduled task] ping"));
    await r.controller.submit("/status");
    assert.match(r.texts().at(-1)!, /\*\*Scheduled\*\* \| 1 job, next at \d\d:\d\d: ping/);
    await r.controller.submit("/loop stop");
    assert.equal(r.controller.statusInfo().scheduled, 0);
    await r.controller.close();
  });

  it("saves the jobs in the session file, after the run and not in the middle of it", async () => {
    const r = rig(sandbox, [{ toolCalls: [{ name: "schedule_wakeup", args: { minutes: 5, reason: "look at the build" } }] }, { text: "waiting" }]);
    await r.controller.start();
    await r.controller.submit("start the build");
    let entries = await r.controller.current()!.agent.log.branch();
    for (let index = 0; index < 100 && !entries.some((entry) => entry.type === "custom"); index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      entries = await r.controller.current()!.agent.log.branch();
    }
    const indexOfSchedule = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === "schedule");
    const indexOfToolResult = entries.findLastIndex((entry) => entry.type === "message" && entry.message.role === "tool");
    assert.ok(indexOfSchedule > indexOfToolResult && indexOfToolResult > 0, `${indexOfSchedule} after ${indexOfToolResult}`);
    assert.equal(readScheduleState(entries)?.jobs[0]?.prompt, "look at the build");
    await r.controller.close();
  });

  it("the agent wakes itself with schedule_wakeup, with the reason as the message", async () => {
    const r = rig(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "schedule_wakeup", args: { minutes: 5, reason: "look at the build" } }] } : index === 1 ? { text: "waiting" } : { text: "build is fine" }));
    await r.controller.start();
    await r.controller.submit("start the build");
    assert.equal(r.controller.statusInfo().scheduled, 1);
    await r.clock.advance(5 * MIN);
    await until(() => r.texts().includes("A:build is fine"), "the wake-up turn");
    assert.ok(r.texts().includes("U:[wake-up you asked for] look at the build"));
    assert.equal(r.controller.statusInfo().scheduled, 0);
    await r.controller.close();
  });

  it("a job that came due during a run waits for the run to end, and fires once", async () => {
    const r = rig(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "bash", args: { command: "sleep 0.5" } }] } : { text: `reply ${index}` }));
    await r.controller.start();
    await r.controller.submit("/loop 1m tick");
    const running = r.controller.submit("long task");
    await until(() => r.controller.driver.working, "the run");
    await r.clock.advance(MIN);
    assert.ok(!r.texts().includes("U:[scheduled task] tick"));
    await running;
    await r.clock.advance(1000);
    await until(() => r.texts().includes("U:[scheduled task] tick"), "the scheduled turn after the run");
    await until(() => !r.controller.driver.working, "the end of it");
    assert.equal(r.texts().filter((text) => text === "U:[scheduled task] tick").length, 1);
    await r.controller.close();
  });

  it("waits while the user is typing", async () => {
    const r = rig(sandbox, [{ text: "ok" }]);
    await r.controller.start();
    await r.controller.submit("/in 1m later");
    r.typing.value = true;
    await r.clock.advance(MIN + 20_000);
    assert.ok(!r.texts().some((text) => text.includes("[scheduled task]")));
    r.typing.value = false;
    await r.clock.advance(15_000);
    await until(() => r.texts().includes("U:[scheduled task] later"), "the scheduled turn");
    await r.controller.close();
  });

  it("resume restores the jobs and a missed time fires once", async () => {
    const clock = fakeClock();
    const first = rig(sandbox, [{ text: "x" }], { clock });
    await first.controller.start();
    await first.controller.submit("hello");
    await first.controller.submit("/loop 5m check");
    const id = first.controller.currentMeta()!.id;
    await first.controller.close();
    // flushing happens when idle, so the entry is already in the file
    clock.set(clock.now() + 3 * 3_600_000);
    const second = rig(sandbox, (_request, index) => ({ text: `again ${index}` }), { clock, store: first.store });
    await second.controller.start({ resume: id });
    assert.equal(second.controller.statusInfo().scheduled, 1);
    await second.clock.advance(3000);
    await until(() => second.texts().includes("U:[scheduled task] check"), "the catch-up turn");
    await until(() => !second.controller.driver.working, "the end of it");
    await second.clock.advance(4 * MIN);
    assert.equal(second.texts().filter((text) => text === "U:[scheduled task] check").length, 1);
    await second.controller.close();
  });

  it("another session starts without the jobs of the first", async () => {
    const r = rig(sandbox, [{ text: "x" }]);
    await r.controller.start();
    await r.controller.submit("/loop 5m check");
    await r.controller.submit("/new");
    assert.equal(r.controller.statusInfo().scheduled, 0);
    await r.controller.close();
  });

  it("exec mode style: scheduling turned off", async () => {
    const transcript = createTranscript();
    const store = createSessionStore(join(sandbox.directory, "sessions"));
    const surface: Surface = { changed: () => undefined, pickSession: async () => undefined, clearScreen: () => undefined, prefill: () => undefined, exit: () => undefined };
    const controller = createController({ settings: { ...DEFAULT_SETTINGS, permissions: "full-access", schedule: { ...DEFAULT_SETTINGS.schedule, enabled: false } }, cwd: sandbox.directory, home: undefined, env: {}, store, transcript, surface, clients: { agent: scriptedClient([{ text: "x" }]) } });
    await controller.start();
    await controller.submit("/loop 5m check");
    assert.ok(transcript.blocks().some((block) => block.kind === "notice" && /turned off/.test(block.text)));
    await controller.close();
  });
});
