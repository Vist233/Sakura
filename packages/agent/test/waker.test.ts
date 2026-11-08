// The rules for when an agent starts a run by itself, checked on the waker alone with stand-ins for the agent and the kernel.
import { describe, expect, it } from "vitest";
import type { RunHandle } from "@sakura/kernel";
import { createWaker } from "../src/wake.ts";
import type { WakeSetting } from "../src/wake.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A waker with a pretend agent: what is pending is set by the test, and every run it starts is recorded. */
function harness(setting?: WakeSetting) {
  const state = { signals: [] as string[], watching: [] as string[], busy: false };
  const started: Array<string | undefined> = [];
  const shown: RunHandle[] = [];
  let drained = 0;
  const waker = createWaker({
    setting: setting ? { ...setting, onRun: (handle) => (shown.push(handle), setting.onRun(handle)) } : undefined,
    pending: () => ({ signals: [...state.signals], watching: [...state.watching] }),
    start: (input) => {
      started.push(input);
      waker.started();
      const handle = {
        events: {
          [Symbol.asyncIterator]: async function* () {
            drained++;
            yield { type: "run_end" as const, reason: "done" as const };
          },
        },
        result: Promise.resolve({ reason: "done" as const }),
        queue() {},
        steer() {},
        cancel() {},
      } satisfies RunHandle;
      return handle;
    },
    busy: () => state.busy,
  });
  return { waker, state, started, shown, drained: () => drained };
}
const host = (cacheCheckMs?: number): WakeSetting => ({ onRun: () => undefined, ...(cacheCheckMs !== undefined ? { cacheCheckMs } : {}) });

describe("the waker: when work ends", () => {
  it("nothing set and nothing asked: the agent stays quiet", () => {
    const h = harness();
    h.waker.signalled();
    h.waker.signalled({ wake: false });
    expect(h.started).toEqual([]);
  });

  it("nothing set but the work asked: a run starts, no one shows it, and its events are read", async () => {
    const h = harness();
    h.waker.signalled({ wake: true });
    expect(h.started).toEqual([undefined]);
    await delay(10);
    expect(h.drained()).toBe(1);
    expect(h.shown).toEqual([]);
  });

  it("set and the work says nothing: a run starts and goes to the application", () => {
    const h = harness(host());
    h.waker.signalled();
    expect(h.started).toEqual([undefined]);
    expect(h.shown).toHaveLength(1);
  });

  it("set but the work says it does not need to be woken: the work's wish wins", () => {
    const h = harness(host());
    h.waker.signalled({ wake: false });
    expect(h.started).toEqual([]);
  });

  it("set and the work asks too: one run", () => {
    const h = harness(host());
    h.waker.signalled({ wake: true });
    expect(h.started).toHaveLength(1);
  });

  it("a run that is going is not started again", () => {
    const h = harness(host());
    h.state.busy = true;
    h.waker.signalled();
    expect(h.started).toEqual([]);
  });

  it("after close() nothing starts", () => {
    const h = harness(host());
    h.waker.close();
    h.waker.signalled();
    h.waker.ended(false);
    expect(h.started).toEqual([]);
  });
});

describe("the waker: when a run ends", () => {
  it("what ended during the run and was not told is told by a run of its own, if it asked for that", () => {
    const h = harness();
    h.state.busy = true;
    h.waker.signalled({ wake: true }); // ends while a run is going
    h.state.busy = false;
    h.state.signals = ["it ended"];
    h.waker.ended(false);
    expect(h.started).toEqual([undefined]);
  });

  it("what is waiting but did not ask to wake the agent waits for the next run", () => {
    const h = harness();
    h.state.signals = ["it ended"];
    h.waker.ended(false);
    expect(h.started).toEqual([]);
  });

  it("with the application's setting, whatever is waiting is told by a run of its own", () => {
    const h = harness(host());
    h.state.signals = ["it ended"];
    h.waker.ended(false);
    expect(h.started).toEqual([undefined]);
  });

  it("a run that told the agent everything leaves nothing owed", () => {
    const h = harness();
    h.state.busy = true;
    h.waker.signalled({ wake: true });
    h.state.busy = false;
    h.waker.ended(false); // nothing is waiting any more: the run told it
    h.state.signals = ["something else, which did not ask"];
    h.waker.ended(false);
    expect(h.started).toEqual([]);
  });

  it("starting a run clears what was owed", () => {
    const h = harness();
    h.state.busy = true;
    h.waker.signalled({ wake: true });
    h.waker.started();
    h.state.busy = false;
    h.state.signals = ["arrived later"];
    h.waker.ended(false);
    expect(h.started).toEqual([]);
  });

  it("after a cancelled run nothing starts by itself, even with the setting and something waiting", () => {
    const h = harness(host());
    h.state.signals = ["it ended"];
    h.state.watching = ["job"];
    h.waker.ended(true);
    expect(h.started).toEqual([]);
  });

  it("a cancelled run forgets what was owed", () => {
    const h = harness();
    h.state.busy = true;
    h.waker.signalled({ wake: true });
    h.waker.ended(true);
    h.state.busy = false;
    h.state.signals = ["it ended"];
    h.waker.ended(false);
    expect(h.started).toEqual([]);
  });
});

describe("the waker: one check before the prompt cache expires", () => {
  it("with the setting and work under way, a quiet agent is woken once to check on it, with the names of what is under way", async () => {
    const h = harness(host(30));
    h.state.watching = ["build", "server"];
    h.waker.ended(false);
    expect(h.started).toEqual([]);
    await delay(80);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toContain("build, server");
    expect(h.started[0]).toContain("Check on it once");
    h.waker.ended(false); // quiet again, still under way: it is left alone now
    await delay(80);
    expect(h.started).toHaveLength(1);
  });

  it("work ending that wakes the agent gives the next quiet period its check again", async () => {
    const h = harness(host(30));
    h.state.watching = ["job", "other"];
    h.waker.ended(false);
    await delay(80);
    expect(h.started).toHaveLength(1); // the check
    h.waker.signalled(); // one of them ends: the agent is woken to hear about it
    expect(h.started).toHaveLength(2);
    h.waker.ended(false); // quiet again, the other is still under way
    await delay(80);
    expect(h.started).toHaveLength(3); // checked once more
  });

  it("work ending that asked not to wake the agent does not start a new quiet period", async () => {
    const h = harness(host(30));
    h.state.watching = ["job", "other"];
    h.waker.ended(false);
    await delay(80);
    expect(h.started).toHaveLength(1);
    h.waker.signalled({ wake: false });
    h.waker.ended(false);
    await delay(80);
    expect(h.started).toHaveLength(1); // the agent has not spoken since the check, so it is not checked again
  });

  it("without the setting there is no check, whatever the work asked", async () => {
    const h = harness();
    h.state.watching = ["job"];
    h.waker.ended(false);
    await delay(80);
    expect(h.started).toEqual([]);
  });

  it("no work under way, no check", async () => {
    const h = harness(host(30));
    h.waker.ended(false);
    await delay(80);
    expect(h.started).toEqual([]);
  });

  it("if something ended meanwhile, the run that starts is the one that tells it, not a check", async () => {
    const h = harness(host(30));
    h.state.watching = ["job"];
    h.waker.ended(false);
    h.state.signals = ["job ended"];
    await delay(80);
    expect(h.started).toEqual([undefined]);
  });

  it("if the work finished and there is nothing to tell, nothing starts", async () => {
    const h = harness(host(30));
    h.state.watching = ["job"];
    h.waker.ended(false);
    h.state.watching = [];
    await delay(80);
    expect(h.started).toEqual([]);
  });

  it("close() cancels the check", async () => {
    const h = harness(host(30));
    h.state.watching = ["job"];
    h.waker.ended(false);
    h.waker.close();
    await delay(80);
    expect(h.started).toEqual([]);
  });

  it("a cancelled run cancels the check", async () => {
    const h = harness(host(30));
    h.state.watching = ["job"];
    h.waker.ended(false);
    h.waker.ended(true);
    await delay(80);
    expect(h.started).toEqual([]);
  });

  it("the check waits four minutes unless told otherwise", () => {
    // the default is a promise to the application: a little under the five minutes a prompt cache usually lasts
    const h = harness(host());
    h.state.watching = ["job"];
    h.waker.ended(false);
    h.waker.close(); // nothing to wait for here: only that arming does not start anything at once
    expect(h.started).toEqual([]);
  });
});
