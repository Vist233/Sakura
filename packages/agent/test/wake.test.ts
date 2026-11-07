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
