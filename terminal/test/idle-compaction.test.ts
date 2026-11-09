import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createIdleCompaction } from "../src/idle-compaction.ts";

const MINUTE = 60_000;

describe("idle compaction", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  function setup(overrides: { enabled?: boolean; busy?: boolean; typing?: boolean } = {}) {
    const state = { busy: overrides.busy ?? false, typing: overrides.typing ?? false, compactions: 0 };
    const idle = createIdleCompaction({
      enabled: overrides.enabled ?? true,
      idleMs: 5 * MINUTE,
      retryMs: 30_000,
      busy: () => state.busy,
      typing: () => state.typing,
      compact: async () => {
        state.compactions += 1;
        return true;
      },
    });
    return { state, idle };
  }

  it("compacts once the cache lifetime has passed with no activity", () => {
    const { state, idle } = setup();
    idle.touch();
    mock.timers.tick(5 * MINUTE - 1);
    assert.equal(state.compactions, 0);
    mock.timers.tick(1);
    assert.equal(state.compactions, 1);
  });

  it("starts the wait again on any activity", () => {
    const { state, idle } = setup();
    idle.touch();
    mock.timers.tick(4 * MINUTE);
    idle.touch();
    mock.timers.tick(4 * MINUTE);
    assert.equal(state.compactions, 0);
    mock.timers.tick(MINUTE);
    assert.equal(state.compactions, 1);
  });

  it("does nothing while a run is going and tries again later", () => {
    const { state, idle } = setup({ busy: true });
    idle.touch();
    mock.timers.tick(5 * MINUTE);
    assert.equal(state.compactions, 0);
    state.busy = false;
    mock.timers.tick(30_000);
    assert.equal(state.compactions, 1);
  });

  it("waits while text is typed in the composer, and retries until it is gone", () => {
    const { state, idle } = setup({ typing: true });
    idle.touch();
    mock.timers.tick(5 * MINUTE + 90_000);
    assert.equal(state.compactions, 0);
    state.typing = false;
    mock.timers.tick(30_000);
    assert.equal(state.compactions, 1);
  });

  it("never fires when it is turned off or stopped", () => {
    const off = setup({ enabled: false });
    off.idle.touch();
    mock.timers.tick(60 * MINUTE);
    assert.equal(off.state.compactions, 0);
    const stopped = setup();
    stopped.idle.touch();
    stopped.idle.stop();
    mock.timers.tick(60 * MINUTE);
    assert.equal(stopped.state.compactions, 0);
  });

  it("survives a failing compaction", async () => {
    const idle = createIdleCompaction({ enabled: true, idleMs: MINUTE, retryMs: 1000, busy: () => false, typing: () => false, compact: () => Promise.reject(new Error("boom")) });
    idle.touch();
    mock.timers.tick(MINUTE);
    await Promise.resolve();
    idle.touch();
    mock.timers.tick(MINUTE);
  });
});
