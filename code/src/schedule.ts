// Scheduled wake-ups: a session starts a turn by itself at a chosen time. This module is the whole mechanism and has no UI: the
// spec parser, the scheduler (jobs, limits, timing from an injected clock), the `/loop` and `/in` command logic that the terminal and
// the ACP front end share, and the helper that keeps the jobs in the session file. The front ends only say whether the session is busy
// (or the user is typing) and how to run a prompt (the pattern of `idle-compaction.ts`).
import type { ScheduleSettings } from "./config.ts";
import type { LogEntry } from "./framework.ts";

// ---------- the clock ----------

/** Time comes only from here, so tests can move it by hand. */
export interface Clock {
  now(): number;
  /** Calls `fn` after `ms` once; returns the function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, Math.min(ms, MAX_TIMER_MS));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

// ---------- specs ----------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const SPEC = /^(?:(?:every|in)\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b\s*([\s\S]*)$/i;

/** `5m`, `every 30m`, `in 20m`, `2h`, `1d` and the text that follows; undefined when the text does not start with a time. */
export function splitSpec(text: string): { everyMs: number; rest: string } | undefined {
  const match = SPEC.exec(text.trim());
  if (!match) return undefined;
  const unit = UNIT_MS[match[2]!.charAt(0).toLowerCase()]!;
  const everyMs = Math.round(Number(match[1]) * unit);
  return everyMs > 0 ? { everyMs, rest: match[3]!.trim() } : undefined;
}

/** `90 s` -> "90s", 300000 -> "5m", 7200000 -> "2h". */
export function formatDuration(ms: number): string {
  for (const [unit, size] of [["d", UNIT_MS.d!], ["h", UNIT_MS.h!], ["m", UNIT_MS.m!]] as const) if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/** The local time of day, for example "14:05". */
export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// ---------- jobs and the scheduler ----------

export type JobKind = "once" | "interval" | "wakeup";

export interface Job {
  id: string;
  prompt: string;
  kind: JobKind;
  /** The delay of a one-time job, the period of a recurring one. (Another way to say "when", a cron expression, would be a field next to this one.) */
  everyMs: number;
  nextAt: number;
  runs: number;
  lastRunAt?: number;
  paused: boolean;
  createdAt: number;
  expiresAt: number;
  /** Turns that failed in a row. */
  failures: number;
}

export interface ScheduleState {
  jobs: Job[];
  /** Self wake-ups scheduled so far in this session. */
  wakeups: number;
  /** The last id handed out. */
  seq: number;
}

export interface FireOutcome {
  ok: boolean;
  /** The provider's quota or rate limit stopped the turn: the job is stopped. */
  quota?: boolean;
}

const QUOTA_ERROR = /quota|rate.?limit|usage limit|too many requests|\b429\b/i;

/** How a finished run counts for a job: only `done` is a success, and a quota or rate limit (a pause for quota, or such a provider error) stops the job. */
export function outcomeOfRun(result: { reason: string; pause?: string | undefined; error?: string | undefined }): FireOutcome {
  const quota = result.pause === "quota" || (result.reason === "error" && QUOTA_ERROR.test(result.error ?? ""));
  return { ok: result.reason === "done", ...(quota ? { quota: true } : {}) };
}

export interface SchedulerOptions {
  settings: ScheduleSettings;
  clock: Clock;
  /** A turn runs (or the agent is being rebuilt). */
  busy(): boolean;
  /** The user has text in the composer (terminal only). */
  typing?(): boolean;
  /** Runs the job's prompt as a turn and says how it went. A throw counts as a failure. */
  fire(job: Job): Promise<FireOutcome>;
  /** The jobs changed: write them down. */
  save?(state: ScheduleState): void;
  /** Tells the person something the scheduler did on its own (a job stopped or expired). */
  notify?(text: string): void;
  /** How long to wait before trying again when the moment was bad. Default 15 s. */
  retryMs?: number;
  /** How long after a run ends a job that came due meanwhile may fire. Default 1 s (the client has the answer by then). */
  settleMs?: number;
  /** How long after a restore a job that came due while the program was away fires. Default 3 s. */
  restoreDelayMs?: number;
  random?: () => number;
}

export type Added = { job: Job } | { error: string };

export interface Scheduler {
  readonly settings: ScheduleSettings;
  /** The agent may schedule its own wake-ups. */
  readonly wakeupAvailable: boolean;
  /** A recurring (`interval`) or one-time (`once`) job from the user. */
  add(input: { prompt: string; everyMs: number; kind: "once" | "interval" }): Added;
  /** A self wake-up in `minutes` (1 to 60, other values are clamped); the pending one is replaced. */
  wakeup(minutes: number, reason: string): { job: Job; minutes: number; replaced: boolean } | { error: string };
  list(): Job[];
  /** Jobs that are not paused. */
  active(): number;
  /** The job that fires next. */
  next(): Job | undefined;
  /** Without an id: all. Say how many jobs changed. */
  stop(id?: string): number;
  pause(id?: string): number;
  resume(id?: string): number;
  /** Replaces the jobs with those of a session file. A job that came due while away fires once, shortly after. */
  load(state: ScheduleState | undefined): void;
  state(): ScheduleState;
  /** A run ended: a job that came due meanwhile may fire. */
  poke(): void;
  close(): void;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { settings, clock } = options;
  const retryMs = options.retryMs ?? 15_000;
  const settleMs = options.settleMs ?? 1000;
  const restoreDelayMs = options.restoreDelayMs ?? 3000;
  const random = options.random ?? Math.random;
  let jobs: Job[] = [];
  let seq = 0;
  let wakeups = 0;
  let firing = false;
  let closed = false;
  let cancelTimer: (() => void) | undefined;

  const state = (): ScheduleState => ({ jobs: jobs.map((job) => ({ ...job })), wakeups, seq });
  const save = () => options.save?.(state());
  const jitter = (everyMs: number) => Math.round(random() * (settings.jitterPercent / 100) * everyMs);
  const isDue = (job: Job, at: number) => !job.paused && job.nextAt <= at;
  const wakeupAvailable = settings.enabled && settings.wakeupTool;

  function arm(delay?: number) {
    cancelTimer?.();
    cancelTimer = undefined;
    if (closed) return;
    let wait = delay;
    if (wait === undefined) {
      const times = jobs.flatMap((job) => (job.paused ? [job.expiresAt] : [job.nextAt, job.expiresAt]));
      if (times.length === 0) return;
      wait = Math.max(0, Math.min(...times) - clock.now());
    }
    cancelTimer = clock.after(wait, () => {
      cancelTimer = undefined;
      void tick();
    });
  }

  function remove(job: Job, why: string) {
    jobs = jobs.filter((item) => item !== job);
    options.notify?.(`Scheduled job ${job.id} (${label(job)}) ${why}.`);
  }

  async function tick() {
    if (closed || firing) return;
    const at = clock.now();
    const expired = jobs.filter((item) => item.expiresAt <= at);
    for (const job of expired) remove(job, `expired after ${settings.expireDays} days`);
    const due = jobs.filter((job) => isDue(job, at)).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!due) {
      if (expired.length > 0) save();
      return arm();
    }
    if (options.busy() || options.typing?.()) return arm(retryMs);
    firing = true;
    // a one-time job leaves the list before it runs; a recurring one is moved on at once and again when the run is over
    due.runs += 1;
    due.lastRunAt = at;
    if (due.kind === "interval") due.nextAt = at + due.everyMs + jitter(due.everyMs);
    else jobs = jobs.filter((job) => job !== due);
    save();
    let outcome: FireOutcome;
    try {
      outcome = await options.fire({ ...due });
    } catch {
      outcome = { ok: false };
    }
    firing = false;
    if (jobs.includes(due)) {
      due.failures = outcome.ok ? 0 : due.failures + 1;
      due.nextAt = clock.now() + due.everyMs + jitter(due.everyMs);
      if (outcome.quota) remove(due, "stopped: the provider's quota or rate limit ended the turn");
      else if (due.failures >= 3) remove(due, "stopped after 3 failed turns in a row");
      else if (due.runs >= settings.maxRuns) remove(due, `stopped after ${settings.maxRuns} runs`);
    } else if (!outcome.ok) options.notify?.(`Scheduled job ${due.id} (${label(due)}) did not finish${outcome.quota ? ": the provider's quota or rate limit ended the turn" : ""}.`);
    save();
    arm();
  }

  function create(kind: JobKind, prompt: string, everyMs: number): Job {
    const at = clock.now();
    const job: Job = { id: String(++seq), prompt, kind, everyMs, nextAt: at + everyMs + (kind === "interval" ? jitter(everyMs) : 0), runs: 0, paused: false, createdAt: at, expiresAt: at + settings.expireDays * DAY, failures: 0 };
    jobs.push(job);
    save();
    arm();
    return job;
  }

  function change(id: string | undefined, applies: (job: Job) => boolean, apply: (job: Job) => void): number {
    const chosen = jobs.filter((job) => (id === undefined || job.id === id) && applies(job));
    for (const job of chosen) apply(job);
    if (chosen.length > 0) {
      save();
      arm();
    }
    return chosen.length;
  }

  return {
    settings,
    wakeupAvailable,
    add({ prompt, everyMs, kind }) {
      if (!settings.enabled) return { error: "Scheduling is turned off ([schedule] enabled = false in config.toml)." };
      if (prompt.trim() === "") return { error: "Say what to do each time." };
      if (everyMs < settings.minIntervalMinutes * MINUTE) return { error: `The shortest time is ${settings.minIntervalMinutes} minute${settings.minIntervalMinutes === 1 ? "" : "s"}.` };
      if (everyMs > settings.expireDays * DAY) return { error: `Jobs end after ${settings.expireDays} days, so ${formatDuration(everyMs)} is too long.` };
      if (jobs.length >= settings.maxJobs) return { error: `A session can hold ${settings.maxJobs} scheduled jobs. Stop one first (/loop stop <id>).` };
      return { job: create(kind, prompt.trim(), everyMs) };
    },
    wakeup(minutes, reason) {
      if (!wakeupAvailable) return { error: "Self wake-ups are turned off ([schedule] in config.toml)." };
      if (!Number.isFinite(minutes)) return { error: "minutes must be a number from 1 to 60." };
      if (wakeups >= settings.maxRuns) return { error: `This session already used its ${settings.maxRuns} wake-ups.` };
      const previous = jobs.find((job) => job.kind === "wakeup");
      if (jobs.length - (previous ? 1 : 0) >= settings.maxJobs) return { error: `A session can hold ${settings.maxJobs} scheduled jobs; no room for a wake-up.` };
      if (previous) jobs = jobs.filter((job) => job !== previous);
      wakeups += 1;
      const clamped = Math.min(60, Math.max(1, Math.round(minutes)));
      return { job: create("wakeup", reason.trim() === "" ? "continue" : reason.trim(), clamped * MINUTE), minutes: clamped, replaced: previous !== undefined };
    },
    list: () => jobs.map((job) => ({ ...job })),
    active: () => jobs.filter((job) => !job.paused).length,
    next: () => jobs.filter((job) => !job.paused).sort((a, b) => a.nextAt - b.nextAt)[0],
    stop(id) {
      const gone = jobs.filter((job) => id === undefined || job.id === id).length;
      jobs = jobs.filter((job) => id !== undefined && job.id !== id);
      if (gone > 0) {
        save();
        arm();
      }
      return gone;
    },
    pause: (id) => change(id, (job) => !job.paused, (job) => void (job.paused = true)),
    resume: (id) =>
      change(id, (job) => job.paused, (job) => {
        job.paused = false;
        job.nextAt = Math.max(job.nextAt, clock.now() + (job.kind === "interval" ? job.everyMs : 0));
      }),
    load(loaded) {
      const at = clock.now();
      jobs = (loaded?.jobs ?? []).filter((job) => job.expiresAt > at).map((job) => ({ ...job, nextAt: job.nextAt <= at ? at + restoreDelayMs : job.nextAt }));
      seq = Math.max(loaded?.seq ?? 0, ...jobs.map((job) => Number(job.id) || 0));
      wakeups = loaded?.wakeups ?? 0;
      arm();
    },
    state,
    poke() {
      if (!firing && !closed && jobs.some((job) => isDue(job, clock.now()))) arm(settleMs);
    },
    close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

// ---------- what the person sees ----------

const label = (job: Job): string => (job.kind === "interval" ? `every ${formatDuration(job.everyMs)}` : job.kind === "wakeup" ? "wake-up" : `in ${formatDuration(job.everyMs)}`);
const short = (text: string, width = 50): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
};

/** The text that starts the turn: the model learns why it is awake. */
export const promptFor = (job: Pick<Job, "kind" | "prompt">): string => (job.kind === "wakeup" ? `[wake-up you asked for] ${job.prompt}` : `[scheduled task] ${job.prompt}`);

/** One line for `/status`: how many jobs and the next one. */
export function scheduleSummary(scheduler: Scheduler): string {
  const total = scheduler.list().length;
  if (total === 0) return scheduler.settings.enabled ? "no jobs" : "off";
  const next = scheduler.next();
  const paused = total - scheduler.active();
  return `${total} job${total === 1 ? "" : "s"}${paused > 0 ? ` (${paused} paused)` : ""}${next ? `, next at ${clockTime(next.nextAt)}: ${short(next.prompt, 40)}` : ""}`;
}

function table(jobs: readonly Job[]): string {
  const rows = jobs.map((job) => `| ${job.id} | ${label(job)} | ${short(job.prompt).replaceAll("|", "\\|")} | ${job.paused ? "paused" : clockTime(job.nextAt)} | ${job.runs} |`);
  return ["| Id | When | Prompt | Next | Runs |", "|---|---|---|---|---|", ...rows].join("\n");
}

export interface CommandReply {
  text: string;
  error: boolean;
}

const USAGE_LOOP = "Usage: `/loop <interval> <prompt>` (for example `/loop 10m check the build`), `/loop` to list, `/loop stop|pause|resume [id]`.";
const USAGE_IN = "Usage: `/in <duration> <prompt>` (for example `/in 20m look at the deploy`).";

/** `/loop ...` and `/in ...`, the same in the terminal and in ACP. */
export function scheduleCommand(scheduler: Scheduler, name: "loop" | "in", args: string): CommandReply {
  const fail = (text: string): CommandReply => ({ text, error: true });
  const ok = (text: string): CommandReply => ({ text, error: false });
  const text = args.trim();
  if (name === "loop") {
    if (text === "") {
      const jobs = scheduler.list();
      return ok(jobs.length === 0 ? `No scheduled jobs. ${USAGE_LOOP}` : table(jobs));
    }
    const verb = /^(stop|pause|resume)(?:\s+(\S+))?$/i.exec(text);
    if (verb) {
      const action = verb[1]!.toLowerCase() as "stop" | "pause" | "resume";
      const done = scheduler[action](verb[2]);
      const past = { stop: "Stopped", pause: "Paused", resume: "Resumed" }[action];
      if (done === 0) return fail(verb[2] ? `There is no job ${verb[2]}. \`/loop\` lists them.` : "There are no scheduled jobs.");
      return ok(`${past} ${done} job${done === 1 ? "" : "s"}.`);
    }
  }
  const spec = splitSpec(text);
  if (!spec || spec.rest === "") return fail(name === "loop" ? USAGE_LOOP : USAGE_IN);
  const added = scheduler.add({ prompt: spec.rest, everyMs: spec.everyMs, kind: name === "loop" ? "interval" : "once" });
  if ("error" in added) return fail(added.error);
  const { job } = added;
  return ok(`Scheduled job ${job.id}: ${label(job)}, first run at ${clockTime(job.nextAt)}. It runs when this session is idle. \`/loop stop ${job.id}\` ends it.`);
}

// ---------- keeping the jobs in the session file ----------

export const SCHEDULE_ENTRY = "schedule";

const isJob = (value: unknown): value is Job => {
  const job = value as Partial<Job> | null;
  return typeof job === "object" && job !== null && typeof job.id === "string" && typeof job.prompt === "string" && typeof job.nextAt === "number" && typeof job.expiresAt === "number" && typeof job.everyMs === "number" && typeof job.kind === "string";
};

/** The jobs the latest `schedule` entry of the conversation holds. */
export function readScheduleState(entries: readonly LogEntry[]): ScheduleState | undefined {
  const entry = entries.findLast((item) => item.type === "custom" && item.customType === SCHEDULE_ENTRY);
  if (!entry || entry.type !== "custom") return undefined;
  const data = entry.data as Partial<ScheduleState> | null;
  if (!data || !Array.isArray(data.jobs)) return undefined;
  return { jobs: data.jobs.filter(isJob), wakeups: typeof data.wakeups === "number" ? data.wakeups : 0, seq: typeof data.seq === "number" ? data.seq : 0 };
}

export interface Persister {
  save(state: ScheduleState): void;
  /** Writes what could not be written during a run. Call it when a run ends. */
  flush(): void;
}

/**
 * Writes the jobs as a log entry. Not while a run is going: the entry would sit between a tool call and its result in the log.
 * A change during a run is written by `flush` when it ends. Writes keep their order; a failed write is dropped (the next change writes again).
 */
export function createPersister(options: { append(state: ScheduleState): Promise<unknown>; busy(): boolean }): Persister {
  let latest: ScheduleState | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const write = () => {
    const state = latest;
    latest = undefined;
    if (state) chain = chain.then(() => options.append(state)).catch(() => undefined);
  };
  return {
    save(state) {
      latest = state;
      if (!options.busy()) write();
    },
    flush() {
      if (latest && !options.busy()) write();
    },
  };
}
