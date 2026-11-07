import type { PluginApi } from "@sakura/kernel";
import { describe, expect, it } from "vitest";
import { contextPlugin } from "@sakura/plugin-context";
import { limitsPlugin } from "@sakura/plugin-limits";
import { toolsPlugin } from "@sakura/plugin-tools";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundle, compose } from "../../src/compose.ts";
import { drain, textOf, withAgent } from "./helpers.ts";

describe("G. real plugins inside a bundle", () => {
  it("G1 the default set wrapped in a bundle behaves like the plain list (AGENTS.md is still loaded)", async () => {
    await withAgent([bundle("core", [contextPlugin(), toolsPlugin(), limitsPlugin()])], [{ text: "ok" }], async (agent, client, dir) => {
      await writeFile(join(dir, "AGENTS.md"), "RULE-42");
      await drain(agent.run("hi"));
      expect(textOf(client.requests[0]!.messages[0]!)).toContain("RULE-42");
    });
  });

  it("G2 limits inside a bundle still pauses the run", async () => {
    await withAgent([bundle("guarded", [limitsPlugin({ maxTurns: 1 })])], [{ toolCalls: [{ name: "read", args: { path: "x" } }] }, { text: "never" }, { text: "never" }], async (agent) => {
      const result = await drain(agent.run("go"));
      expect(result.reason).toBe("paused");
    });
  });

  it("G3 one plugin instance used by two agents shares its closure state; a factory call per agent does not", async () => {
    const make = () => {
      let turns = 0;
      return { name: "counter", seen: () => turns, setup: (api: PluginApi) => api.on("turn.end", () => void turns++) };
    };
    const shared = make();
    for (let i = 0; i < 2; i++) await withAgent([shared as never], [{ text: "ok" }], async (agent) => void (await drain(agent.run("go"))));
    expect(shared.seen()).toBe(2); // both agents counted into the same variable
    const readings: number[] = [];
    for (let i = 0; i < 2; i++) {
      const fresh = make();
      await withAgent([fresh as never], [{ text: "ok" }], async (agent) => void (await drain(agent.run("go"))));
      readings.push(fresh.seen());
    }
    expect(readings).toEqual([1, 1]);
  });

  it("G4 compose() on the real plugins keeps their order and drops nothing", () => {
    const flat = compose([bundle("core", [contextPlugin(), toolsPlugin()]), limitsPlugin()]);
    expect(flat.map((p) => p.name)).toEqual(["context", "tools", "limits"]);
  });
});

describe("H. scale", () => {
  it("H1 200 children, nesting depth 100: builds and runs", async () => {
    let hits = 0;
    const leaf = (i: number) => ({ name: `p${i}`, setup: (api: PluginApi) => api.on("context", () => void hits++) }) as never;
    let nested = bundle("level0", [leaf(0)]);
    for (let depth = 1; depth < 100; depth++) nested = bundle(`level${depth}`, [nested, leaf(depth)]);
    const wide = bundle(
      "wide",
      Array.from({ length: 200 }, (_, i) => leaf(1000 + i)),
    );
    await withAgent([nested, wide], [{ text: "ok" }], async (agent) => void (await drain(agent.run("hi"))));
    expect(hits).toBe(300);
  });
});
