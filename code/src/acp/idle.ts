// Compacts a session that has been idle for as long as the provider keeps its prompt cache: the cached prefix is gone by then, so a
// smaller context costs the least. The timing is the terminal's own (`createIdleCompaction`) and so are the settings
// (`auto_compact_idle`, `cache_ttl_minutes`, `auto_compact_min_tokens`); only the wiring to ACP sessions lives here.
import { createIdleCompaction } from "../idle-compaction.ts";
import type { IdleCompaction } from "../idle-compaction.ts";
import type { Settings } from "../config.ts";
import type { Logger } from "./log.ts";
import type { Sessions } from "./sessions.ts";

export interface IdleCompactor {
  /** Something happened in the session (it was opened, a turn ended): the idle time starts again. */
  touch(sessionId: string): void;
  stop(): void;
}

export interface IdleCompactorOptions {
  settings: Pick<Settings, "autoCompactIdle" | "cacheTtlMinutes" | "autoCompactMinTokens">;
  sessions: Pick<Sessions, "busy" | "compactIdle">;
  /** Told after a session was compacted (the client's meter is out of date). */
  compacted(sessionId: string): Promise<void>;
  log: Logger;
}

export function createIdleCompactor(options: IdleCompactorOptions): IdleCompactor {
  const { settings, sessions, log } = options;
  const timers = new Map<string, IdleCompaction>();
  const idleMs = settings.cacheTtlMinutes * 60_000;

  const timerFor = (sessionId: string): IdleCompaction => {
    let timer = timers.get(sessionId);
    if (!timer) {
      timer = createIdleCompaction({
        enabled: settings.autoCompactIdle,
        idleMs,
        retryMs: Math.min(30_000, idleMs),
        busy: () => sessions.busy(sessionId),
        typing: () => false,
        compact: async () => {
          const result = await sessions.compactIdle(sessionId, settings.autoCompactMinTokens);
          if (!result) return false;
          log.info("compacted after idle", { session: sessionId, minutes: settings.cacheTtlMinutes, tokensBefore: result.before, tokensAfter: result.after });
          await options.compacted(sessionId).catch(() => undefined);
          return true;
        },
      });
      timers.set(sessionId, timer);
    }
    return timer;
  };

  return {
    touch: (sessionId) => timerFor(sessionId).touch(),
    stop() {
      for (const timer of timers.values()) timer.stop();
      timers.clear();
    },
  };
}
