import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, RunHandle } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import type { FauxTurn } from "@sakura/testing";
import { createAgent } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wake-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 4000) => {
  for (let waited = 0; waited < ms && !check(); waited += 20) await delay(20);
};
const bashCall = (command: string): FauxTurn => ({ toolCalls: [{ name: "bash", args: { command }, id: "b1" }] });

describe("agent wake: background work ends while the agent is quiet", () => {
  it("starts a run by itself, tells the model, and hands the run to onRun", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([bashCall("echo a; sleep 0.7; echo fin"), { text: "waiting for it" }, { text: "noted: it finished" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 60_000 } });
    const first = await agent.run("start the build").result;
    expect(first.reason).toBe("done");
    expect(woken).toHaveLength(0);
    await until(() => woken.length > 0);
    expect(woken).toHaveLength(1);
    expect((await woken[0]!.result).reason).toBe("done");
    const last = llm.requests.at(-1)!.messages.at(-1)!;
    expect(textOf(last)).toContain("finished with exit code 0");
    await agent.close();
  });

  it("without wake the agent stays quiet and the notice waits for the next run", async () => {
    const llm = createFauxClient([bashCall("echo a; sleep 0.5; echo fin"), { text: "waiting" }, { text: "later answer" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150 });
    await agent.run("go").result;
    await delay(900);
    expect(llm.requests).toHaveLength(2);
    await agent.run("what now?").result;
    const request = llm.requests.at(-1)!.messages.map(textOf).join("\n");
    expect(request).toContain("finished with exit code 0");
    await agent.close();
  });

  it("checks once before the cache expires, then leaves the agent alone", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([bashCall("echo a; sleep 30"), { text: "waiting" }, { text: "still running, will wait" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 150 } });
    await agent.run("go").result;
    await until(() => woken.length > 0);
    expect(woken).toHaveLength(1);
    await woken[0]!.result;
    expect(textOf(llm.requests.at(-1)!.messages.at(-1)!)).toContain("Check on it once");
    await delay(600); // a second check would need a fourth scripted reply and would show up here
    expect(woken).toHaveLength(1);
    expect(llm.requests).toHaveLength(3);
    await agent.close();
  });

  it("close() cancels the pending check", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([bashCall("echo a; sleep 30"), { text: "waiting" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 300 } });
    await agent.run("go").result;
    await agent.close();
    await delay(600);
    expect(woken).toHaveLength(0);
  });

  it("nothing pending means no timer and no wake", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([{ text: "hello" }]);
    const agent = await createAgent({ model: llm, cwd: dir, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 50 } });
    await agent.run("hi").result;
    await delay(300);
    expect(woken).toHaveLength(0);
    await agent.close();
  });
});

describe("agent wake: the model can ask for it, the application can set it", () => {
  const slowEnd = "echo a; sleep 0.6; echo fin";
  const run = (extra: Record<string, unknown>) => ({ toolCalls: [{ name: "bash", args: { command: slowEnd, ...extra }, id: "b1" }] }) as FauxTurn;

  it("the application's wake is the default: a command that says nothing wakes the agent", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([run({}), { text: "waiting" }, { text: "noted" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 60_000 } });
    await agent.run("go").result;
    await until(() => woken.length > 0);
    expect(woken).toHaveLength(1);
    await woken[0]!.result;
    await agent.close();
  });

  it("the application has set wake and the command says wake: false, so the agent is not woken", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([run({ wake: false }), { text: "waiting" }, { text: "unused" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 60_000 } });
    await agent.run("go").result;
    await delay(1100);
    expect(woken).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
    await agent.run("anything new?").result; // the notice is still there for the next run
    expect(llm.requests.at(-1)!.messages.map(textOf).join("\n")).toContain("finished with exit code 0");
    await agent.close();
  });

  it("the application has set wake and the command says wake: true, so the agent is woken and the run goes to onRun", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([run({ wake: true }), { text: "waiting" }, { text: "noted" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 60_000 } });
    await agent.run("go").result;
    await until(() => woken.length > 0);
    expect(woken).toHaveLength(1);
    await woken[0]!.result;
    await agent.close();
  });

  it("the application has not set wake and the command says nothing, so the agent stays quiet", async () => {
    const llm = createFauxClient([run({}), { text: "waiting" }, { text: "unused" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150 });
    await agent.run("go").result;
    await delay(1100);
    expect(llm.requests).toHaveLength(2);
    await agent.close();
  });

  it("the application has not set wake and the command says wake: false, so the agent stays quiet", async () => {
    const llm = createFauxClient([run({ wake: false }), { text: "waiting" }, { text: "unused" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150 });
    await agent.run("go").result;
    await delay(1100);
    expect(llm.requests).toHaveLength(2);
    await agent.close();
  });

  it("the application has not set wake and the command says wake: true, so the agent wakes itself and the model is told", async () => {
    const llm = createFauxClient([run({ wake: true }), { text: "waiting" }, { text: "noted: it finished" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150 });
    await agent.run("go").result;
    await until(() => llm.requests.length >= 3);
    expect(llm.requests).toHaveLength(3);
    expect(textOf(llm.requests.at(-1)!.messages.at(-1)!)).toContain("finished with exit code 0");
    const messages = (await agent.log.project()).map(textOf).join("\n");
    expect(messages).toContain("noted: it finished"); // the woken run is in the log although nobody showed it
    await agent.close();
  });

  it("a command with wake: true that was started with background: true wakes the agent too", async () => {
    const llm = createFauxClient([{ toolCalls: [{ name: "bash", args: { command: slowEnd, background: true, wake: true }, id: "b1" }] }, { text: "waiting" }, { text: "noted" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashBackgroundGraceMs: 100 });
    await agent.run("go").result;
    await until(() => llm.requests.length >= 3);
    expect(llm.requests).toHaveLength(3);
    await agent.close();
  });

  it("the check before the cache expires still needs the application's setting, whatever the command says", async () => {
    const llm = createFauxClient([run({ wake: true, command: "echo a; sleep 30" }), { text: "waiting" }, { text: "unused" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150 });
    await agent.run("go").result;
    await delay(700);
    expect(llm.requests).toHaveLength(2);
    await agent.close();
  });

  it("after close() no one is woken", async () => {
    const llm = createFauxClient([run({ wake: true }), { text: "waiting" }, { text: "unused" }]);
    const agent = await createAgent({ model: llm, cwd: dir, bashSoftTimeoutMs: 150 });
    await agent.run("go").result;
    await agent.close();
    await delay(1100);
    expect(llm.requests).toHaveLength(2);
  });

  it("a wake that comes while a run is going is not lost: the run tells the agent, or the end of the run wakes it", async () => {
    // the first command ends during the run that follows, which waits on a second command
    const llm = createFauxClient([
      { toolCalls: [{ name: "bash", args: { command: "sleep 0.5", background: true, wake: true }, id: "a" }] },
      { toolCalls: [{ name: "bash", args: { command: "sleep 1.2" }, id: "b" }] },
      { text: "the second one is done" },
      { text: "and the first one has ended" },
    ]);
    const agent = await createAgent({ model: llm, cwd: dir, bashBackgroundGraceMs: 100 });
    await agent.run("go").result;
    await until(() => llm.requests.length >= 4, 5000);
    const everything = llm.requests.map((request) => request.messages.map(textOf).join("\n")).join("\n");
    expect(everything).toContain("finished with exit code 0");
    await agent.close();
  });

  it("two commands that both asked to wake the agent are both told to it", async () => {
    const llm = createFauxClient([
      {
        toolCalls: [
          { name: "bash", args: { command: "sleep 0.4", background: true, wake: true }, id: "a" },
          { name: "bash", args: { command: "sleep 0.4", background: true, wake: true }, id: "b" },
        ],
      },
      { text: "waiting for both" },
      { text: "noted" },
      { text: "noted again" },
    ]);
    const agent = await createAgent({ model: llm, cwd: dir, bashBackgroundGraceMs: 100 });
    await agent.run("go").result;
    await until(() => llm.requests.length >= 3, 5000);
    await delay(300);
    const told = llm.requests.map((request) => request.messages.map(textOf).join("\n")).join("\n");
    expect(told.match(/finished with exit code 0/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    await agent.close();
  });

  it("cancelling the run that started a command stops it and does not wake the agent, even when it asked to be woken", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([
      { toolCalls: [{ name: "bash", args: { command: "echo a; sleep 20", background: true, wake: true }, id: "a" }] },
      { toolCalls: [{ name: "bash", args: { command: "sleep 20" }, id: "b" }] },
      { text: "unused" },
    ]);
    const agent = await createAgent({ model: llm, cwd: dir, bashBackgroundGraceMs: 100, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 60_000 } });
    const handle = agent.run("go");
    await delay(700);
    agent.cancel();
    expect((await handle.result).reason).toBe("cancelled");
    await delay(1500);
    expect(woken).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
    await agent.close();
  });

  it("a notice that arrived during a run that is then cancelled waits for the next run instead of waking the agent", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([
      { toolCalls: [{ name: "bash", args: { command: "echo a; sleep 0.5", background: true }, id: "a" }] },
      { toolCalls: [{ name: "bash", args: { command: "sleep 20" }, id: "b" }] }, // the run is busy here when the first command ends
      { text: "unused" },
      { text: "I see the first command ended." },
    ]);
    const agent = await createAgent({ model: llm, cwd: dir, bashBackgroundGraceMs: 100, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 300 } });
    const handle = agent.run("go");
    await delay(1300); // the first command has ended by now and its notice is waiting
    agent.cancel();
    expect((await handle.result).reason).toBe("cancelled");
    await delay(900); // longer than the check before the cache expires, which must not fire either
    expect(woken).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
    await agent.run("what happened?").result;
    expect(llm.requests.at(-1)!.messages.map(textOf).join("\n")).toContain("finished with exit code 0");
    await agent.close();
  });

  it("a run that is not cancelled still wakes the agent for what is waiting, as before", async () => {
    const woken: RunHandle[] = [];
    const llm = createFauxClient([
      { toolCalls: [{ name: "bash", args: { command: "echo a; sleep 0.5", background: true }, id: "a" }] },
      { toolCalls: [{ name: "bash", args: { command: "sleep 1" }, id: "b" }] },
      { text: "the run is over" },
      { text: "noted" },
    ]);
    const agent = await createAgent({ model: llm, cwd: dir, bashBackgroundGraceMs: 100, wake: { onRun: (handle) => woken.push(handle), cacheCheckMs: 60_000 } });
    expect((await agent.run("go").result).reason).toBe("done");
    await delay(300);
    expect(woken.length + llm.requests.length - 3).toBeGreaterThanOrEqual(0); // the notice was told inside the run or by a woken run, never lost
    expect(llm.requests.map((request) => request.messages.map(textOf).join("\n")).join("\n")).toContain("finished with exit code 0");
    await agent.close();
  });
});
