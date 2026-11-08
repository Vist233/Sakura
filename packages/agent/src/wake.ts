import type { RunHandle } from "@sakura/kernel";

/** What the application can ask for. */
export interface WakeSetting {
  /** Receives every run the agent starts by itself, to show its events. */
  onRun(handle: RunHandle): void;
  /** How long a quiet agent with work still under way is left before it is woken once to check on it (default 4 minutes, a little under the prompt cache lifetime). */
  cacheCheckMs?: number;
}

export interface WakerOptions {
  /** The application's setting; with none, the agent is woken only for work that asked for it. */
  setting: WakeSetting | undefined;
  /** What the kernel says is waiting: notices the agent has not been told yet, and work that is still under way. */
  pending(): { signals: string[]; watching: string[] };
  /** Starts a run on the agent's conversation. With no input it tells the agent what is waiting. */
  start(input?: string): RunHandle;
  /** Whether a run is going now. */
  busy(): boolean;
}

/**
 * When the agent starts a run by itself. It decides three things and keeps the state they need in one place:
 *   - when background work ends and the agent is quiet, a run starts so that it hears about it, if the application asked for that in general or the work asked
 *     for it in particular (the work's own wish wins);
 *   - a quiet agent with work still under way is woken once to check on it before the prompt cache expires, then left alone until something ends;
 *   - after a run that was cancelled nothing starts by itself: whoever cancelled wanted it to stop, and what is waiting is told in the next run.
 */
export interface Waker {
  /** Background work ended. `options.wake` is what that work asked for; left out, the application's setting decides. */
  signalled(options?: { wake?: boolean }): void;
  /** A run is starting. It tells the agent everything that is waiting. */
  started(): void;
  /** A run ended. */
  ended(cancelled: boolean): void;
  /** No more runs by itself. */
  close(): void;
}

const CACHE_CHECK_MS = 240_000;

const checkInput = (labels: string[]): string =>
  `Background work you started is still running: ${labels.join(", ")}. Check on it once now (for example read its output), then stop and wait; you will be told when it ends. Do not poll.`;

/** The run of an agent that woke itself when the application gave no setting: nobody shows it, the log has all of it. */
async function drain(handle: RunHandle): Promise<void> {
  for await (const _event of handle.events) void _event;
}

export function createWaker(options: WakerOptions): Waker {
  const { setting } = options;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let checkUsed = false; // the one check per quiet period has been made
  let owed = false; // something that asked to wake the agent ended, and no run has told it yet

  function wakeWith(input?: string): void {
    if (closed || options.busy()) return;
    const handle = options.start(input);
    if (setting) setting.onRun(handle);
    else void drain(handle);
  }

  return {
    signalled(wish) {
      if (!(wish?.wake ?? setting !== undefined)) return;
      clearTimeout(timer);
      checkUsed = false;
      owed = true;
      wakeWith(); // while a run is going, it delivers the notice itself or `ended` does
    },
    started() {
      owed = false;
    },
    ended(cancelled) {
      if (closed) return;
      if (cancelled) {
        owed = false;
        clearTimeout(timer);
        return;
      }
      const pending = options.pending();
      if (pending.signals.length > 0 && (setting || owed)) {
        wakeWith();
        return;
      }
      if (pending.signals.length === 0) owed = false;
      if (!setting) return; // the check before the cache expires is the application's to ask for
      if (pending.watching.length === 0 || checkUsed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = options.pending();
        if (now.signals.length > 0) return wakeWith();
        if (now.watching.length === 0) return;
        checkUsed = true;
        wakeWith(checkInput(now.watching));
      }, setting.cacheCheckMs ?? CACHE_CHECK_MS);
      timer.unref();
    },
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
