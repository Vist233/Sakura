// The scheduled jobs of one ACP session: a scheduler that runs a due job as a turn through the client side (`ScheduleSink`), and the persister that
// saves the jobs into the session file when no turn is running.
import { createPersister, createScheduler, systemClock } from "../schedule.ts";
import type { ScheduleSettings } from "../config.ts";
import type { Clock, FireOutcome, Job, Persister, Scheduler } from "../schedule.ts";

/** What a scheduler needs from the client side (see schedule.ts): to run a due job as a turn and to tell the person something. */
export interface ScheduleSink {
  fire(sessionId: string, job: Job): Promise<FireOutcome>;
  say(sessionId: string, text: string): void;
}

export function createSessionSchedule(options: {
  sessionId: string;
  settings: ScheduleSettings;
  clock?: Clock;
  sink?: ScheduleSink;
  /** A turn is running or about to; nothing is saved or fired meanwhile. */
  busy(): boolean;
  /** Writes the jobs into the session file. */
  append(state: unknown): Promise<void>;
}): { schedule: Scheduler; persister: Persister } {
  const { sessionId, sink } = options;
  const persister = createPersister({ append: options.append, busy: options.busy });
  const schedule = createScheduler({
    settings: options.settings,
    clock: options.clock ?? systemClock,
    busy: options.busy,
    fire: (job) => sink?.fire(sessionId, job) ?? Promise.resolve({ ok: false }),
    save: persister.save,
    notify: (text) => sink?.say(sessionId, text),
  });
  return { schedule, persister };
}
