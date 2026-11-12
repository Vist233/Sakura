// A clock that only moves when a test says so. `advance` runs the timers that come due, in order, and lets the promises they start settle.
import type { Clock } from "../../src/schedule.ts";

export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  /** Timers waiting. */
  pending(): number;
  set(at: number): void;
}

export function fakeClock(start = Date.parse("2026-01-01T12:00:00")): FakeClock {
  let time = start;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const settle = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    now: () => time,
    after(ms, fn) {
      const timer = { at: time + ms, fn };
      timers.push(timer);
      return () => void (timers = timers.filter((item) => item !== timer));
    },
    pending: () => timers.length,
    set: (at) => void (time = at),
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        time = Math.max(time, next.at);
        next.fn();
        await settle();
      }
      time = end;
      await settle();
    },
  };
}
