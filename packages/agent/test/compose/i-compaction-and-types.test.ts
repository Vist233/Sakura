import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgent } from "../../src/index.ts";
import type { Plugin } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { bundle } from "../../src/compose.ts";
import { drain, naiveBundle } from "./helpers.ts";

async function compactingRun(plugin: Plugin) {
  const dir = await mkdtemp(join(tmpdir(), "lab-compact-"));
  const client = createFauxClient((request, index) => ({ text: index === 0 || request.system.length >= 0 ? `reply ${index} ${"x".repeat(400)}` : "", usage: { input: 900, output: 50 } }), {
    contextWindow: 1000,
  });
  const agent = await createAgent({ model: client, cwd: dir, plugins: [plugin], compaction: { reserveTokens: 100, keepRecentTokens: 50 } });
  try {
    for (let i = 0; i < 6; i++) await drain(agent.run(`question ${i} ${"y".repeat(300)}`));
    return (await agent.log.branch()).some((entry) => entry.type === "compaction");
  } finally {
    await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("I. afterCompaction through a real compaction", () => {
  it("I1 a child's afterCompaction is called when the real agent compacts (bundle forwards it)", async () => {
    let after = 0;
    const child: Plugin = { name: "child", setup() {}, afterCompaction: async () => void after++ };
    const compacted = await compactingRun(bundle("suite", [child]));
    expect(compacted).toBe(true);
    expect(after).toBeGreaterThan(0);
  });

  it("I2 the naive bundle never calls it", async () => {
    let after = 0;
    const child: Plugin = { name: "child", setup() {}, afterCompaction: async () => void after++ };
    await compactingRun(naiveBundle("suite", [child]));
    expect(after).toBe(0);
  });
});
