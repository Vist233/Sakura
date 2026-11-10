// Compacts the conversation once the session has been idle for as long as the provider keeps its prompt cache:
// the cached prefix is gone anyway then, so a smaller context costs the least. Only the timing lives here.

export interface IdleCompactionOptions {
  enabled: boolean;
  /** How long the session must be idle (the cache lifetime). */
  idleMs: number;
  /** How long to wait before trying again when the moment was bad (a run is going, text is typed). */
  retryMs: number;
  /** A run is going. */
  busy(): boolean;
  /** The user has text in the composer. */
  typing(): boolean;
  /** Compacts if the context is large enough; says whether it did. Errors are the caller's to report. */
  compact(): Promise<boolean>;
}

export interface IdleCompaction {
  /** Something happened (a key, a run): the idle time starts again. */
  touch(): void;
  stop(): void;
}

export function createIdleCompaction(options: IdleCompactionOptions): IdleCompaction {
  let timer: NodeJS.Timeout | undefined;
  let compacting = false;

  const arm = (delay: number) => {
    clearTimeout(timer);
    timer = undefined;
    if (options.enabled) {
      timer = setTimeout(fire, delay);
      timer.unref();
    }
  };

  async function fire() {
    timer = undefined;
    if (compacting) return;
    if (options.busy() || options.typing()) return arm(options.retryMs);
    compacting = true;
    try {
      await options.compact();
    } catch {
      // the controller reports failures; the next activity starts a new wait
    } finally {
      compacting = false;
    }
  }

  return {
    touch: () => arm(options.idleMs),
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
