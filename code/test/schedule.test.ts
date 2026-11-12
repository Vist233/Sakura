import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SCHEDULE } from "../src/config.ts";
import type { ScheduleSettings } from "../src/config.ts";
import { createPersister, createScheduler, formatDuration, outcomeOfRun, promptFor, readScheduleState, scheduleCommand, scheduleSummary, splitSpec } from "../src/schedule.ts";
import type { FireOutcome, Job, ScheduleState, Scheduler } from "../src/schedule.ts";
import { fakeClock } from "./support/fake-clock.ts";

const MIN = 60_000;

function rig(settings: Partial<ScheduleSettings> = {}, fire: (job: Job) => Promise<FireOutcome> = async () => ({ ok: true })) {
  const clock = fakeClock();
  const state = { busy: false, typing: false };
  const fired: Job[] = [];
  const saved: ScheduleState[] = [];
  const notes: string[] = [];
  const scheduler = createScheduler({
    settings: { ...DEFAULT_SCHEDULE, ...settings },
    clock,
    busy: () => state.busy,
    typing: () => state.typing,
    fire: async (job) => {
      fired.push(job);
      return fire(job);
    },
    save: (next) => void saved.push(next),
    notify: (text) => void notes.push(text),
    random: () => 0.5,
  });
  return { clock, state, fired, saved, notes, scheduler };
}

const added = (scheduler: Scheduler, prompt: string, everyMs: number, kind: "once" | "interval" = "interval"): Job => {
  const result = scheduler.add({ prompt, everyMs, kind });
  assert.ok("job" in result, "error" in result ? result.error : "");
  return result.job;
};

describe("schedule specs", () => {
  it("reads the forms people type", () => {
    assert.deepEqual(splitSpec("5m check it"), { everyMs: 5 * MIN, rest: "check it" });
    assert.deepEqual(splitSpec("every 30m do x"), { everyMs: 30 * MIN, rest: "do x" });
    assert.deepEqual(splitSpec("in 20 minutes look"), { everyMs: 20 * MIN, rest: "look" });
    assert.deepEqual(splitSpec("2h"), { everyMs: 120 * MIN, rest: "" });
    assert.deepEqual(splitSpec("1d x"), { everyMs: 86_400_000, rest: "x" });
    assert.deepEqual(splitSpec("1.5h x"), { everyMs: 90 * MIN, rest: "x" });
    assert.deepEqual(splitSpec("90s x"), { everyMs: 90_000, rest: "x" });
  });

  it("refuses text that does not start with a time", () => {
    for (const text of ["check it", "m 5", "5 apples", "0m x", "5mx y", ""]) assert.equal(splitSpec(text), undefined, text);
  });

  it("writes durations the short way", () => {
    assert.equal(formatDuration(5 * MIN), "5m");
    assert.equal(formatDuration(2 * 3_600_000), "2h");
    assert.equal(formatDuration(86_400_000), "1d");
    assert.equal(formatDuration(90_000), "2m");
    assert.equal(formatDuration(30_000), "30s");
  });
});

describe("scheduler", () => {
  it("fires a recurring job when due, then again one period after the run", async () => {
    const r = rig();
    const job = added(r.scheduler, "check", 5 * MIN);
    assert.equal(job.id, "1");
    await r.clock.advance(4 * MIN);
    assert.equal(r.fired.length, 0);
    await r.clock.advance(MIN);
    assert.equal(r.fired.length, 1);
    assert.equal(r.fired[0]!.prompt, "check");
    await r.clock.advance(5 * MIN);
    assert.equal(r.fired.length, 2);
    assert.equal(r.scheduler.list()[0]!.runs, 2);
  });

  it("fires a one-time job once and forgets it", async () => {
    const r = rig();
    added(r.scheduler, "later", 20 * MIN, "once");
    await r.clock.advance(20 * MIN);
    assert.equal(r.fired.length, 1);
    assert.deepEqual(r.scheduler.list(), []);
    await r.clock.advance(60 * MIN);
    assert.equal(r.fired.length, 1);
    assert.equal(r.clock.pending(), 0);
  });

  it("while busy, a due job waits and fires once when the session is idle (no catch-up)", async () => {
    const r = rig();
    added(r.scheduler, "check", 5 * MIN);
    r.state.busy = true;
    await r.clock.advance(60 * MIN);
    assert.equal(r.fired.length, 0);
    r.state.busy = false;
    await r.clock.advance(15_000);
    assert.equal(r.fired.length, 1);
    await r.clock.advance(4 * MIN);
    assert.equal(r.fired.length, 1);
  });

  it("poke lets a due job go soon after a run ends, not after the retry delay", async () => {
    const r = rig();
    added(r.scheduler, "check", 5 * MIN);
    r.state.busy = true;
    await r.clock.advance(5 * MIN);
    r.state.busy = false;
    r.scheduler.poke();
    await r.clock.advance(1000);
    assert.equal(r.fired.length, 1);
  });

  it("while the user types the fire is tried again later", async () => {
    const r = rig();
    added(r.scheduler, "check", 5 * MIN);
    r.state.typing = true;
    await r.clock.advance(5 * MIN + 30_000);
    assert.equal(r.fired.length, 0);
    r.state.typing = false;
    await r.clock.advance(15_000);
    assert.equal(r.fired.length, 1);
  });

  it("jobs due at the same time fire one after the other, each once", async () => {
    const order: string[] = [];
    const r = rig({}, async (job) => {
      order.push(job.id);
      return { ok: true };
    });
    added(r.scheduler, "a", 5 * MIN);
    added(r.scheduler, "b", 5 * MIN);
    await r.clock.advance(5 * MIN);
    assert.deepEqual(order, ["1", "2"]);
  });

  it("does not start a second fire while one runs", async () => {
    let release!: () => void;
    const r = rig({}, () => new Promise<FireOutcome>((resolve) => (release = () => resolve({ ok: true }))));
    added(r.scheduler, "slow", MIN);
    added(r.scheduler, "other", MIN);
    await r.clock.advance(10 * MIN);
    assert.equal(r.fired.length, 1);
    release();
    await r.clock.advance(0);
    await r.clock.advance(MIN);
    assert.ok(r.fired.length >= 2);
  });

  it("limits: shortest time, number of jobs, longest life", () => {
    const r = rig({ maxJobs: 2 });
    assert.match(String((r.scheduler.add({ prompt: "x", everyMs: 30_000, kind: "interval" }) as { error: string }).error), /shortest time is 1 minute/);
    added(r.scheduler, "a", MIN);
    added(r.scheduler, "b", MIN);
    assert.match(String((r.scheduler.add({ prompt: "c", everyMs: MIN, kind: "interval" }) as { error: string }).error), /2 scheduled jobs/);
    const small = rig({ expireDays: 1 });
    assert.match(String((small.scheduler.add({ prompt: "x", everyMs: 2 * 86_400_000, kind: "once" }) as { error: string }).error), /too long/);
    assert.match(String((small.scheduler.add({ prompt: "  ", everyMs: MIN, kind: "once" }) as { error: string }).error), /what to do/);
  });

  it("is off when disabled", () => {
    const r = rig({ enabled: false });
    assert.match(String((r.scheduler.add({ prompt: "x", everyMs: MIN, kind: "once" }) as { error: string }).error), /turned off/);
    assert.equal(r.scheduler.wakeupAvailable, false);
  });

  it("a job expires", async () => {
    const r = rig({ expireDays: 1 });
    added(r.scheduler, "x", 10 * 60 * MIN);
    await r.clock.advance(24 * 60 * MIN + MIN);
    assert.equal(r.fired.length, 2);
    assert.deepEqual(r.scheduler.list(), []);
    assert.match(r.notes.at(-1)!, /expired after 1 days/);
  });

  it("a job ends after max runs", async () => {
    const r = rig({ maxRuns: 3 });
    added(r.scheduler, "x", MIN);
    await r.clock.advance(10 * MIN);
    assert.equal(r.fired.length, 3);
    assert.deepEqual(r.scheduler.list(), []);
    assert.match(r.notes.at(-1)!, /after 3 runs/);
  });

  it("a job stops itself after three failed turns in a row", async () => {
    const results = [false, false, true, false, false, false];
    const r = rig({}, async () => ({ ok: results.shift() ?? true }));
    added(r.scheduler, "x", MIN);
    await r.clock.advance(20 * MIN);
    assert.equal(r.fired.length, 6);
    assert.deepEqual(r.scheduler.list(), []);
    assert.match(r.notes.at(-1)!, /3 failed turns in a row/);
  });

  it("a throwing fire counts as a failure", async () => {
    const r = rig({}, async () => {
      throw new Error("boom");
    });
    added(r.scheduler, "x", MIN);
    await r.clock.advance(10 * MIN);
    assert.equal(r.fired.length, 3);
    assert.deepEqual(r.scheduler.list(), []);
  });

  it("a quota stop ends the job at once", async () => {
    const r = rig({}, async () => ({ ok: false, quota: true }));
    added(r.scheduler, "x", MIN);
    await r.clock.advance(5 * MIN);
    assert.equal(r.fired.length, 1);
    assert.deepEqual(r.scheduler.list(), []);
    assert.match(r.notes.at(-1)!, /quota or rate limit/);
  });

  it("pause, resume and stop", async () => {
    const r = rig();
    added(r.scheduler, "a", 5 * MIN);
    added(r.scheduler, "b", 5 * MIN);
    assert.equal(r.scheduler.pause("1"), 1);
    assert.equal(r.scheduler.active(), 1);
    await r.clock.advance(5 * MIN);
    assert.deepEqual(r.fired.map((job) => job.id), ["2"]);
    await r.clock.advance(30 * MIN);
    r.fired.length = 0;
    assert.equal(r.scheduler.resume("1"), 1);
    await r.clock.advance(4 * MIN);
    assert.deepEqual(r.fired.map((job) => job.id), []);
    await r.clock.advance(MIN);
    assert.ok(r.fired.some((job) => job.id === "1"));
    assert.equal(r.scheduler.stop("2"), 1);
    assert.equal(r.scheduler.stop("9"), 0);
    assert.equal(r.scheduler.stop(), 1);
    assert.deepEqual(r.scheduler.list(), []);
    assert.equal(r.scheduler.pause(), 0);
  });

  it("jitter delays a recurring job by part of its period, and only that kind", async () => {
    const r = rig({ jitterPercent: 20 });
    const job = added(r.scheduler, "x", 10 * MIN);
    assert.equal(job.nextAt - r.clock.now(), 10 * MIN + MIN);
    const once = added(r.scheduler, "y", 10 * MIN, "once");
    assert.equal(once.nextAt - r.clock.now(), 10 * MIN);
  });

  it("reports changes for saving", () => {
    const r = rig();
    added(r.scheduler, "x", MIN);
    assert.equal(r.saved.at(-1)!.jobs.length, 1);
    r.scheduler.stop();
    assert.equal(r.saved.at(-1)!.jobs.length, 0);
  });

  it("close ends the timers", async () => {
    const r = rig();
    added(r.scheduler, "x", MIN);
    r.scheduler.close();
    await r.clock.advance(10 * MIN);
    assert.equal(r.fired.length, 0);
  });
});

describe("restore", () => {
  it("a job whose time passed while away fires once, not once per missed period", async () => {
    const first = rig();
    added(first.scheduler, "x", 5 * MIN);
    const saved = first.saved.at(-1)!;
    const second = rig();
    second.clock.set(first.clock.now() + 3 * 3_600_000);
    second.scheduler.load(saved);
    await second.clock.advance(2000);
    assert.equal(second.fired.length, 0);
    await second.clock.advance(2000);
    assert.equal(second.fired.length, 1);
    await second.clock.advance(4 * MIN);
    assert.equal(second.fired.length, 1);
    await second.clock.advance(MIN);
    assert.equal(second.fired.length, 2);
  });

  it("drops expired jobs, keeps paused ones paused and carries on the numbering", async () => {
    const first = rig();
    added(first.scheduler, "a", 5 * MIN);
    added(first.scheduler, "b", 5 * MIN);
    first.scheduler.pause("2");
    const saved = first.saved.at(-1)!;
    const second = rig({ expireDays: 30 });
    second.clock.set(first.clock.now() + 31 * 86_400_000);
    second.scheduler.load(saved);
    assert.deepEqual(second.scheduler.list(), []);
    const third = rig();
    third.scheduler.load(saved);
    assert.equal(third.scheduler.list().find((job) => job.id === "2")?.paused, true);
    assert.equal(added(third.scheduler, "c", MIN).id, "3");
    await third.clock.advance(10 * MIN);
    assert.ok(third.fired.every((job) => job.id !== "2"));
  });

  it("loading nothing clears the jobs", () => {
    const r = rig();
    added(r.scheduler, "x", MIN);
    r.scheduler.load(undefined);
    assert.deepEqual(r.scheduler.list(), []);
  });
});

describe("self wake-ups", () => {
  it("clamps the time to 1..60 minutes", () => {
    const r = rig();
    const long = r.scheduler.wakeup(500, "later");
    assert.ok("job" in long && long.minutes === 60);
    const short = r.scheduler.wakeup(0.2, "now");
    assert.ok("job" in short && short.minutes === 1);
    assert.match(String((r.scheduler.wakeup(Number.NaN, "x") as { error: string }).error), /number/);
  });

  it("keeps one pending: a new call replaces the earlier one", async () => {
    const r = rig();
    const first = r.scheduler.wakeup(10, "first");
    assert.ok("job" in first && !first.replaced);
    const second = r.scheduler.wakeup(5, "second");
    assert.ok("job" in second && second.replaced);
    assert.deepEqual(r.scheduler.list().map((job) => job.prompt), ["second"]);
    await r.clock.advance(5 * MIN);
    assert.deepEqual(r.fired.map((job) => job.prompt), ["second"]);
    assert.equal(r.scheduler.list().length, 0);
  });

  it("can schedule the next wake-up while it is awake", async () => {
    const r = rig();
    r.scheduler.wakeup(1, "again");
    await r.clock.advance(MIN);
    assert.equal(r.fired.length, 1);
    assert.ok("job" in r.scheduler.wakeup(1, "and again"));
  });

  it("is capped per session", () => {
    const r = rig({ maxRuns: 2 });
    assert.ok("job" in r.scheduler.wakeup(1, "a"));
    assert.ok("job" in r.scheduler.wakeup(1, "b"));
    assert.match(String((r.scheduler.wakeup(1, "c") as { error: string }).error), /already used its 2 wake-ups/);
  });

  it("counts toward the number of jobs, and the count survives a restore", () => {
    const r = rig({ maxJobs: 1 });
    added(r.scheduler, "x", MIN);
    assert.match(String((r.scheduler.wakeup(1, "a") as { error: string }).error), /no room/);
    const s = rig({ maxRuns: 1 });
    s.scheduler.wakeup(1, "a");
    const saved = s.saved.at(-1)!;
    const t = rig({ maxRuns: 1 });
    t.scheduler.load(saved);
    assert.ok("error" in t.scheduler.wakeup(1, "b"));
  });

  it("is refused when the tool is off", () => {
    const r = rig({ wakeupTool: false });
    assert.equal(r.scheduler.wakeupAvailable, false);
    assert.match(String((r.scheduler.wakeup(1, "a") as { error: string }).error), /turned off/);
  });
});

describe("commands", () => {
  it("lists, adds, pauses, resumes and stops", () => {
    const r = rig();
    assert.match(scheduleCommand(r.scheduler, "loop", "").text, /No scheduled jobs/);
    const reply = scheduleCommand(r.scheduler, "loop", "10m check the build | now");
    assert.equal(reply.error, false);
    assert.match(reply.text, /Scheduled job 1: every 10m, first run at \d\d:\d\d/);
    assert.match(scheduleCommand(r.scheduler, "in", "in 20m look at it").text, /Scheduled job 2: in 20m/);
    const listing = scheduleCommand(r.scheduler, "loop", "").text;
    assert.match(listing, /\| 1 \| every 10m \| check the build \\\| now \|/);
    assert.match(listing, /\| 2 \| in 20m \| look at it \|/);
    assert.equal(scheduleCommand(r.scheduler, "loop", "pause 1").text, "Paused 1 job.");
    assert.match(scheduleCommand(r.scheduler, "loop", "").text, /paused/);
    assert.equal(scheduleCommand(r.scheduler, "loop", "resume").text, "Resumed 1 job.");
    assert.equal(scheduleCommand(r.scheduler, "loop", "stop 2").text, "Stopped 1 job.");
    assert.equal(scheduleCommand(r.scheduler, "loop", "STOP").text, "Stopped 1 job.");
  });

  it("explains mistakes", () => {
    const r = rig();
    for (const [name, args] of [["loop", "check it"], ["loop", "5m"], ["in", ""], ["in", "20m"], ["loop", "stop the server in 5m"]] as const) {
      const reply = scheduleCommand(r.scheduler, name, args);
      assert.equal(reply.error, true, `${name} ${args}`);
      assert.match(reply.text, /Usage/);
    }
    assert.match(scheduleCommand(r.scheduler, "loop", "stop 7").text, /no job 7/);
    assert.match(scheduleCommand(r.scheduler, "loop", "pause").text, /no scheduled jobs/);
    assert.match(scheduleCommand(r.scheduler, "loop", "10s x").text, /shortest time/);
  });

  it("summarises for /status", () => {
    const r = rig();
    assert.equal(scheduleSummary(r.scheduler), "no jobs");
    added(r.scheduler, "check the build", 5 * MIN);
    added(r.scheduler, "other", 9 * MIN);
    r.scheduler.pause("2");
    assert.match(scheduleSummary(r.scheduler), /^2 jobs \(1 paused\), next at \d\d:\d\d: check the build$/);
    assert.equal(scheduleSummary(rig({ enabled: false }).scheduler), "off");
  });

  it("tells the model why it is awake", () => {
    assert.equal(promptFor({ kind: "interval", prompt: "x" }), "[scheduled task] x");
    assert.equal(promptFor({ kind: "wakeup", prompt: "x" }), "[wake-up you asked for] x");
  });
});

describe("outcome of a run", () => {
  it("only done is a success; a quota pause or a limit error stops the job", () => {
    assert.deepEqual(outcomeOfRun({ reason: "done" }), { ok: true });
    assert.deepEqual(outcomeOfRun({ reason: "cancelled" }), { ok: false });
    assert.deepEqual(outcomeOfRun({ reason: "paused", pause: "quota" }), { ok: false, quota: true });
    assert.deepEqual(outcomeOfRun({ reason: "paused", pause: "approval" }), { ok: false });
    assert.deepEqual(outcomeOfRun({ reason: "error", error: "HTTP 429 Too Many Requests" }), { ok: false, quota: true });
    assert.deepEqual(outcomeOfRun({ reason: "error", error: "connection reset" }), { ok: false });
  });
});

describe("persistence", () => {
  const state = (n: number): ScheduleState => ({ jobs: [], wakeups: n, seq: n });

  it("reads the latest schedule entry and ignores bad data", () => {
    const entry = (data: unknown, id: string) => ({ id, parentId: null, ts: 0, type: "custom" as const, customType: "schedule", data });
    const job = { id: "1", prompt: "x", kind: "interval", everyMs: MIN, nextAt: 5, runs: 0, paused: false, createdAt: 0, expiresAt: 9, failures: 0 };
    const entries = [entry({ jobs: [job], wakeups: 1, seq: 1 }, "a"), entry({ jobs: [job, { nope: 1 }], wakeups: 2, seq: 3 }, "b")];
    const read = readScheduleState(entries as never);
    assert.equal(read?.jobs.length, 1);
    assert.equal(read?.wakeups, 2);
    assert.equal(read?.seq, 3);
    assert.equal(readScheduleState([]), undefined);
    assert.equal(readScheduleState([entry("junk", "c")] as never), undefined);
  });

  it("writes at once when idle, in order, and holds changes during a run until flush", async () => {
    const written: number[] = [];
    let busy = false;
    const persister = createPersister({ append: async (next) => void written.push(next.seq), busy: () => busy });
    persister.save(state(1));
    persister.save(state(2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [1, 2]);
    busy = true;
    persister.save(state(3));
    persister.save(state(4));
    persister.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [1, 2]);
    busy = false;
    persister.flush();
    persister.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [1, 2, 4]);
  });

  it("a failed write does not stop later ones", async () => {
    const written: number[] = [];
    let fail = true;
    const persister = createPersister({
      append: async (next) => {
        if (fail) throw new Error("disk");
        written.push(next.seq);
      },
      busy: () => false,
    });
    persister.save(state(1));
    await new Promise((resolve) => setImmediate(resolve));
    fail = false;
    persister.save(state(2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, [2]);
  });
});
