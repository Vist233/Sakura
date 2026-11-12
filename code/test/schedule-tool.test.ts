import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SCHEDULE } from "../src/config.ts";
import type { ScheduleSettings } from "../src/config.ts";
import type { Tool } from "../src/framework.ts";
import { createScheduler } from "../src/schedule.ts";
import { schedulePlugin, WAKEUP_TOOL } from "../src/schedule-tool.ts";
import { fakeClock } from "./support/fake-clock.ts";

function setup(settings: Partial<ScheduleSettings> = {}) {
  const scheduler = createScheduler({ settings: { ...DEFAULT_SCHEDULE, ...settings }, clock: fakeClock(), busy: () => false, fire: async () => ({ ok: true }) });
  const tools: Tool[] = [];
  schedulePlugin(scheduler).setup({ on: () => undefined, registerTool: (tool) => void tools.push(tool), emit: () => undefined });
  const call = async (args: unknown) => {
    const result = await tools[0]!.execute(args, {} as never);
    return { text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), isError: result.isError === true };
  };
  return { scheduler, tools, call };
}

describe("schedule_wakeup", () => {
  it("is one read-effect tool that needs minutes and a reason", () => {
    const { tools } = setup();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, WAKEUP_TOOL);
    assert.equal(tools[0]!.effect, "read");
    assert.deepEqual((tools[0]!.parameters as { required: string[] }).required, ["minutes", "reason"]);
  });

  it("schedules a wake-up and says when", async () => {
    const { scheduler, call } = setup();
    const result = await call({ minutes: 10, reason: "check the deploy" });
    assert.equal(result.isError, false);
    assert.match(result.text, /woken at \d\d:\d\d, in 10 minutes/);
    assert.equal(scheduler.list()[0]!.prompt, "check the deploy");
    assert.equal(scheduler.list()[0]!.kind, "wakeup");
  });

  it("clamps the time and says so", async () => {
    const { scheduler, call } = setup();
    assert.match((await call({ minutes: 500, reason: "a" })).text, /in 60 minutes \(the time was changed to 60/);
    assert.match((await call({ minutes: 0, reason: "b" })).text, /in 1 minutes \(the time was changed to 1/);
    assert.equal(scheduler.list().length, 1);
  });

  it("keeps one pending and says it replaced the earlier one", async () => {
    const { scheduler, call } = setup();
    await call({ minutes: 10, reason: "first" });
    assert.match((await call({ minutes: 5, reason: "second" })).text, /earlier wake-up was replaced/);
    assert.deepEqual(scheduler.list().map((job) => job.prompt), ["second"]);
  });

  it("answers with an error when the count limit is reached, and for bad arguments", async () => {
    const { call } = setup({ maxRuns: 1 });
    await call({ minutes: 1, reason: "a" });
    const over = await call({ minutes: 1, reason: "b" });
    assert.equal(over.isError, true);
    assert.match(over.text, /already used its 1 wake-ups/);
    const bad = await call({ minutes: "soon", reason: "c" });
    assert.equal(bad.isError, true);
    assert.equal((await call(undefined)).isError, true);
  });

  it("is not offered when scheduling or the tool is turned off", () => {
    assert.equal(setup({ enabled: false }).tools.length, 0);
    assert.equal(setup({ wakeupTool: false }).tools.length, 0);
  });
});
