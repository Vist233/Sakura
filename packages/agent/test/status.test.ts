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

describe("agent.pending(), agent.goal(), agent.setGoal() and agent.clearGoal()", () => {
  it("pending is empty for a quiet agent", async () => {
    const agent = await createAgent({ model: createFauxClient([]), cwd: dir });
    expect(agent.pending()).toEqual({ signals: [], watching: [] });
    await agent.close();
  });

  it("a goal set between runs is checked, shown by goal(), and ended by clearGoal()", async () => {
    const client = createFauxClient((request) => {
      const last = request.messages
        .at(-1)!
        .content.map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      return last.startsWith("You are about to stop.") ? { text: "- [done] x :: y" } : { text: "finished" };
    });
    const agent = await createAgent({ model: client, cwd: dir });
    expect(await agent.goal()).toBeUndefined();
    await agent.setGoal({ objective: "finish the work" });
    expect(await agent.goal()).toMatchObject({ objective: "finish the work", status: "active" });
    await say(agent, "go");
    expect(await agent.goal()).toMatchObject({ status: "complete" });
    expect(client.requests).toHaveLength(2);
    await agent.setGoal({ objective: "another" });
    await agent.clearGoal();
    expect(await agent.goal()).toMatchObject({ objective: "another", status: "complete" });
    await agent.close();
  });

  it("the goal is part of the session: it is there after the file is opened again, and after a rewind to before it", async () => {
    const sessionFile = join(dir, "goal.jsonl");
    const first = await createAgent({ model: createFauxClient([{ text: "hi" }]), cwd: dir, sessionFile });
    await say(first, "hello");
    const before = (await first.log.branch()).at(-1)!.id;
    await first.setGoal({ objective: "keep going" });
    await first.close();
    const second = await createAgent({ model: createFauxClient([]), cwd: dir, sessionFile });
    expect(await second.goal()).toMatchObject({ objective: "keep going", status: "active" });
    second.rewindTo(before);
    expect(await second.goal()).toBeUndefined();
    await second.close();
  });
});
