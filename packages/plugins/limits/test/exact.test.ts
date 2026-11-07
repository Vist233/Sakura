// Exact boundaries of every limit (added after mutation testing).
import { describe, expect, it } from "vitest";
import type { TurnInfo } from "@sakura/kernel";
import { limitsPlugin } from "../src/index.ts";
import type { LimitsOptions } from "../src/index.ts";

const totals = (over: Partial<TurnInfo["totals"]> = {}): TurnInfo["totals"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, ...over });

/** Runs the plugin's turn.end hook with the given totals and returns what it answered. */
function turnEnd(options: LimitsOptions, over: Partial<TurnInfo["totals"]>, clock?: { runStart?: number; at: number }) {
  let current = clock?.runStart ?? 0;
  const plugin = limitsPlugin({ ...options, now: () => current });
  let handler: ((turn: TurnInfo) => unknown) | undefined;
  let onEvent: ((event: { type: string }) => void) | undefined;
  plugin.setup({
    on: (name: string, fn: never) => {
      if (name === "turn.end") handler = fn;
      if (name === "event") onEvent = fn;
    },
    registerTool: () => undefined,
    emit: () => undefined,
  } as never);
  onEvent?.({ type: "run_start" });
  current = clock?.at ?? current;
  return handler!({ totals: totals(over) } as TurnInfo);
}
const paused = (result: unknown) => (result as { pause?: string } | undefined)?.pause === "budget";

describe("limits: exactly at the limit pauses, one below does not", () => {
  it("turns", () => {
    expect(paused(turnEnd({ maxTurns: 3 }, { turns: 2 }))).toBe(false);
    expect(paused(turnEnd({ maxTurns: 3 }, { turns: 3 }))).toBe(true);
    expect(paused(turnEnd({ maxTurns: 3 }, { turns: 4 }))).toBe(true);
  });
  it("tokens count input, output, cache read and cache write together", () => {
    expect(paused(turnEnd({ maxTokens: 100 }, { input: 40, output: 30, cacheRead: 20, cacheWrite: 9 }))).toBe(false);
    expect(paused(turnEnd({ maxTokens: 100 }, { input: 40, output: 30, cacheRead: 20, cacheWrite: 10 }))).toBe(true);
    expect(paused(turnEnd({ maxTokens: 100 }, { output: 100 }))).toBe(true);
    expect(paused(turnEnd({ maxTokens: 100 }, { cacheWrite: 100 }))).toBe(true);
  });
  it("cost needs prices; without prices it never pauses; at the limit it does", () => {
    const prices = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } as never;
    expect(paused(turnEnd({ maxCostUsd: 1 }, { input: 5_000_000 }))).toBe(false);
    expect(paused(turnEnd({ maxCostUsd: 3, prices }, { input: 1_000_000, output: 999_999 }))).toBe(false);
    expect(paused(turnEnd({ maxCostUsd: 3, prices }, { input: 1_000_000, output: 1_000_000 }))).toBe(true);
  });
  it("run time is measured from the start of this run", () => {
    expect(paused(turnEnd({ maxRunSeconds: 10 }, {}, { runStart: 5_000, at: 14_999 }))).toBe(false);
    expect(paused(turnEnd({ maxRunSeconds: 10 }, {}, { runStart: 5_000, at: 15_000 }))).toBe(true);
  });
  it("with no limits configured nothing pauses, however large the totals", () => {
    expect(turnEnd({}, { turns: 1e9, input: 1e12 })).toBeUndefined();
  });
  it("any single limit is enough", () => {
    expect(paused(turnEnd({ maxTurns: 100, maxTokens: 10 }, { turns: 1, input: 10 }))).toBe(true);
    expect(paused(turnEnd({ maxTurns: 1, maxTokens: 1e9 }, { turns: 1, input: 10 }))).toBe(true);
  });
});

describe("limits: identity and error handling", () => {
  it("has a name and says what it compensates for", () => {
    const plugin = limitsPlugin();
    expect(plugin.name).toBe("limits");
    expect(plugin.compensates).toBe("models do not know what they cost");
  });
  it("update changes the budget used by later turns", () => {
    const plugin = limitsPlugin({ maxTurns: 5 });
    let handler: ((turn: TurnInfo) => unknown) | undefined;
    plugin.setup({
      on: (name: string, fn: never) => {
        if (name === "turn.end") handler = fn;
      },
      registerTool: () => undefined,
      emit: () => undefined,
    } as never);
    expect(paused(handler!({ totals: totals({ turns: 5 }) } as TurnInfo))).toBe(true);
    plugin.update({ maxTurns: 10 });
    expect(paused(handler!({ totals: totals({ turns: 5 }) } as TurnInfo))).toBe(false);
  });
});
