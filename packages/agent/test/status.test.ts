import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFauxClient } from "@sakura/testing";
import { createAgent } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-status-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const say = async (agent: Awaited<ReturnType<typeof createAgent>>, text: string) => {
  const run = agent.run(text);
  for await (const _event of run.events) void _event;
  await run.result;
};

describe("agent.context() and agent.usage(): what the status line of a host needs", () => {
  it("start empty, then follow the conversation", async () => {
    const agent = await createAgent({ model: createFauxClient([{ text: "ok", usage: { input: 3_000, output: 200 } }], { contextWindow: 50_000 }), cwd: dir });
    expect(await agent.context()).toMatchObject({ tokens: 0, window: 50_000, free: 50_000 });
    expect(await agent.usage()).toMatchObject({ turns: 0, input: 0 });
    await say(agent, "hello");
    expect(await agent.context()).toMatchObject({ tokens: 3_200, free: 46_800 });
    expect(await agent.usage()).toMatchObject({ turns: 1, input: 3_000, output: 200 });
    await agent.close();
  });

  it("honour the compaction setting of the agent", async () => {
    const agent = await createAgent({ model: createFauxClient([], { contextWindow: 50_000 }), cwd: dir, compaction: { reserveTokens: 10_000, reserveFraction: 0 } });
    expect((await agent.context()).compactAt).toBe(40_000);
    await agent.close();
    const off = await createAgent({ model: createFauxClient([], { contextWindow: 50_000 }), cwd: dir, compaction: false });
    expect((await off.context()).compactAt).toBeUndefined();
    await off.close();
  });

  it("come back after the session file is opened again", async () => {
    const sessionFile = join(dir, "session.jsonl");
    const first = await createAgent({ model: createFauxClient([{ text: "ok", usage: { input: 700, output: 50 } }]), cwd: dir, sessionFile });
    await say(first, "hello");
    await first.close();
    const second = await createAgent({ model: createFauxClient([]), cwd: dir, sessionFile });
    expect(await second.usage()).toMatchObject({ turns: 1, input: 700, output: 50 });
    expect((await second.context()).tokens).toBe(750);
    await second.close();
  });
});
