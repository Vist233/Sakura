import { describe, expect, it } from "vitest";
import { ProviderError } from "@sakura/kernel";
import type { ProviderErrorKind, UsageTotals } from "@sakura/kernel";
import { createFauxClient, createRng } from "@sakura/testing";
import { createMemoryLog } from "@sakura/session";
import { createKernel } from "@sakura/kernel";
import type { Environment } from "@sakura/kernel";
import { costOf } from "../src/cost.ts";
import { limitsPlugin } from "../src/index.ts";

const env = {
  cwd: "/",
  resolve: (p: string) => p,
  readFile: async () => new Uint8Array(),
  writeFile: async () => undefined,
  stat: async () => undefined,
  list: async () => [],
  exec: async () => ({ exitCode: 0, output: "", timedOut: false }),
  spawn: () => {
    throw new Error("not implemented");
  },
  dispose: async () => undefined,
} as Environment;
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);

function harness(options: Parameters<typeof limitsPlugin>[0], script: ConstructorParameters<never> | Parameters<typeof createFauxClient>[0]) {
  const plugin = limitsPlugin(options);
  const llm = createFauxClient(script);
  const log = createMemoryLog();
  const kernel = createKernel({ llm, env, system: "s", plugins: [plugin], compaction: false, now: () => 1 });
  const run = async (input?: string) => {
    const handle = kernel.run(log, input);
    for await (const _event of handle.events) void _event;
    return handle.result;
  };
  return { plugin, llm, log, run };
}

const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): UsageTotals => ({ input, output, cacheRead, cacheWrite, turns: 1 });

describe("costOf", () => {
  const cases: Array<[UsageTotals, Parameters<typeof costOf>[1], number]> = [
    [usage(1_000_000), { input: 3, output: 15 }, 3],
    [usage(0, 1_000_000), { input: 3, output: 15 }, 15],
    [usage(500_000, 500_000), { input: 2, output: 4 }, 3],
    [usage(0, 0, 1_000_000), { input: 3, output: 15, cacheRead: 0.3 }, 0.3],
    [usage(0, 0, 1_000_000), { input: 3, output: 15 }, 3],
    [usage(0, 0, 0, 1_000_000), { input: 3, output: 15, cacheWrite: 3.75 }, 3.75],
    [usage(0), { input: 3, output: 15 }, 0],
  ];
  for (const [totals, prices, expected] of cases) {
    it(`prices ${JSON.stringify(totals)} at ${JSON.stringify(prices)}`, () => {
      expect(costOf(totals, prices)).toBeCloseTo(expected, 10);
    });
  }
});

describe("turn budget", () => {
  for (const limit of range(8)) {
    for (const extra of [0, 3]) {
      it(`maxTurns ${limit} pauses after reply ${limit} (${extra} spare replies)`, async () => {
        const { run, llm } = harness(
          { maxTurns: limit },
          Array.from({ length: limit + extra + 2 }, (_, index) => ({ toolCalls: [{ name: "none", args: {}, id: `c${index}` }] })),
        );
        const result = await run("go");
        expect(result).toEqual({ reason: "paused", pause: "budget" });
        expect(llm.requests).toHaveLength(limit);
      });
    }
  }
});

describe("token budget against an independent sum", () => {
  for (const seed of range(60, 100)) {
    it(`pauses at the first reply that reaches the limit (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const replies = Array.from({ length: 12 }, () => ({ input: rng.int(5, 80), output: rng.int(1, 40), cacheRead: rng.int(0, 30) }));
      const limit = rng.int(50, 900);
      let running = 0;
      let hitAt: number | undefined;
      for (const [index, reply] of replies.entries()) {
        running += reply.input + reply.output + reply.cacheRead;
        if (running >= limit) {
          hitAt = index + 1;
          break;
        }
      }
      const script = [
        ...replies.map((usageValue, index) => ({ toolCalls: [{ name: "none", args: {}, id: `c${index}` }], usage: usageValue })),
        { text: "end", usage: { input: 0, output: 0, cacheRead: 0 } },
      ];
      const { run, llm } = harness({ maxTokens: limit }, script);
      const result = await run("go");
      expect(llm.requests).toHaveLength(hitAt ?? replies.length + 1);
      expect(result.reason).toBe(hitAt === undefined ? "done" : "paused");
    });
  }
});

describe("cost budget", () => {
  for (const seed of range(30, 300)) {
    it(`stops when the spend reaches the limit (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const prices = { input: rng.int(1, 10), output: rng.int(5, 30) };
      const per = { input: rng.int(1000, 20000), output: rng.int(100, 3000) };
      const turns = rng.int(1, 8);
      const spendPerTurn = (per.input * prices.input + per.output * prices.output) / 1e6;
      const limit = spendPerTurn * turns - spendPerTurn / 2;
      const { run, llm } = harness(
        { maxCostUsd: limit, prices },
        Array.from({ length: turns + 3 }, (_, index) => ({ toolCalls: [{ name: "none", args: {}, id: `c${index}` }], usage: per })),
      );
      const result = await run("go");
      expect(result).toEqual({ reason: "paused", pause: "budget" });
      expect(llm.requests).toHaveLength(turns);
    });
  }

  it("ignores the cost limit when no prices are given", async () => {
    const { run } = harness({ maxCostUsd: 0.0000001 }, [{ text: "x", usage: { input: 1e6, output: 1e6 } }]);
    expect((await run("go")).reason).toBe("done");
  });
});

describe("run time budget", () => {
  for (const seconds of [1, 5, 30, 120]) {
    it(`pauses a run that has gone on for ${seconds} seconds`, async () => {
      let clock = 0;
      const { run } = harness({ maxRunSeconds: seconds, now: () => clock }, (_request, index) => {
        clock += (seconds * 1000) / 2 + 1;
        return index < 5 ? { toolCalls: [{ name: "none", args: {}, id: `c${index}` }] } : { text: "end" };
      });
      expect(await run("go")).toEqual({ reason: "paused", pause: "budget" });
    });
  }

  it("starts counting again with each run", async () => {
    let clock = 0;
    const { run } = harness({ maxRunSeconds: 10, now: () => clock }, (_request, index) => {
      clock += 6000;
      return { text: `r${index}` };
    });
    expect((await run("one")).reason).toBe("done");
    expect((await run("two")).reason).toBe("done");
  });
});

describe("provider errors", () => {
  const kinds: ProviderErrorKind[] = ["rate_limit", "quota", "overloaded", "context_overflow", "auth", "network", "invalid_request", "other"];
  for (const kind of kinds) {
    for (const variant of [1, 2]) {
      it(`${kind} by default ${["rate_limit", "quota"].includes(kind) ? "pauses the run" : "ends the run with an error"} (variant ${variant})`, async () => {
        const { run } = harness({}, [{ error: new ProviderError(kind, "failed") }]);
        const result = await run("go");
        if (kind === "quota" || kind === "rate_limit") expect(result).toEqual({ reason: "paused", pause: "quota" });
        else expect(result.reason).toBe("error");
      });
    }
  }

  it("pauseOn can be changed", async () => {
    const { run } = harness({ pauseOn: ["overloaded"] }, [{ error: new ProviderError("overloaded", "busy") }]);
    expect(await run("go")).toEqual({ reason: "paused", pause: "quota" });
    const other = harness({ pauseOn: ["overloaded"] }, [{ error: new ProviderError("quota", "no credit") }]);
    expect((await other.run("go")).reason).toBe("error");
  });
});

describe("resuming and updating", () => {
  for (const seed of range(15, 400)) {
    it(`raising the budget lets the paused session carry on (seed ${seed})`, async () => {
      const limit = 1 + (seed % 3);
      const { run, plugin, llm } = harness(
        { maxTurns: limit },
        Array.from({ length: 20 }, (_, index) => (index < 10 ? { toolCalls: [{ name: "none", args: {}, id: `c${index}` }] } : { text: "end" })),
      );
      expect(await run("go")).toEqual({ reason: "paused", pause: "budget" });
      plugin.update({ maxTurns: 1000 });
      const second = await run();
      expect(second.reason).toBe("done");
      expect(llm.requests.length).toBeGreaterThan(limit);
    });
  }

  it("without a budget nothing is limited", async () => {
    const { run } = harness({}, [{ toolCalls: [{ name: "none", args: {}, id: "a" }], usage: { input: 1e9, output: 1e9 } }, { text: "end" }]);
    expect((await run("go")).reason).toBe("done");
  });

  it("keeps counting across a restart because the totals come from the log", async () => {
    const plugin = limitsPlugin({ maxTurns: 3 });
    const log = createMemoryLog();
    const make = (script: Parameters<typeof createFauxClient>[0]) => createKernel({ llm: createFauxClient(script), env, system: "s", plugins: [plugin], compaction: false });
    const drain = async (handle: ReturnType<ReturnType<typeof make>["run"]>) => {
      for await (const _event of handle.events) void _event;
      return handle.result;
    };
    expect((await drain(make([{ text: "a" }]).run(log, "1"))).reason).toBe("done");
    expect((await drain(make([{ text: "b" }]).run(log, "2"))).reason).toBe("done");
    expect(await drain(make([{ text: "c" }]).run(log, "3"))).toEqual({ reason: "paused", pause: "budget" });
  });
});

describe("limits: the run time is a budget checked between turns", () => {
  it("a turn that overruns finishes, including its tool, and then the run is paused for the budget", async () => {
    let clock = 0;
    let executed = 0;
    const tool = {
      name: "work",
      description: "",
      parameters: { type: "object" },
      effect: "read" as const,
      execute: async () => (executed++, { content: [{ type: "text" as const, text: "done" }] }),
    };
    const llm = createFauxClient((_request, index) => {
      clock += 5000; // this reply takes five seconds
      return index === 0 ? { toolCalls: [{ name: "work", args: {}, id: "w" }] } : { text: "unused" };
    });
    const kernel = createKernel({ llm, env, system: "s", tools: [tool], plugins: [limitsPlugin({ maxRunSeconds: 1, now: () => clock })], compaction: false, now: () => 1 });
    const handle = kernel.run(createMemoryLog(), "go");
    for await (const _event of handle.events) void _event;
    const result = await handle.result;
    expect(result).toEqual({ reason: "paused", pause: "budget" });
    expect(executed).toBe(1);
    expect(llm.requests).toHaveLength(1);
  });

  it("a run that stays within the time is not touched, and the clock starts again with each run", async () => {
    let clock = 0;
    const llm = createFauxClient(() => ({ text: "ok" }));
    const kernel = createKernel({ llm, env, system: "s", plugins: [limitsPlugin({ maxRunSeconds: 10, now: () => clock })], compaction: false, now: () => 1 });
    const log = createMemoryLog();
    for (let round = 0; round < 3; round++) {
      clock += 3_600_000; // an hour passes between runs
      const handle = kernel.run(log, `q${round}`);
      for await (const _event of handle.events) void _event;
      expect((await handle.result).reason).toBe("done");
    }
  });
});
