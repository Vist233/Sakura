import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Content, Message } from "@sakura/kernel";
import { createFauxClient, createRng } from "@sakura/testing";
import type { FauxTurn } from "@sakura/testing";
import { createAgent } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const textOf = (message: Message) => message.content.map((part: Content) => (part.type === "text" ? part.text : "")).join("");
async function drain(handle: ReturnType<Awaited<ReturnType<typeof createAgent>>["run"]>) {
  const events: string[] = [];
  const reading = (async () => {
    for await (const event of handle.events) events.push(event.type);
  })();
  const result = await handle.result;
  await reading;
  return { result, events };
}

describe("agent: working in a real directory with the four tools", () => {
  for (const seed of range(40)) {
    it(`writes, edits, reads and runs (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const word = `w${rng.int(0, 99999)}`;
      const replacement = `r${rng.int(0, 99999)}`;
      const turns: FauxTurn[] = [
        { toolCalls: [{ name: "write", args: { path: "notes/a.txt", content: `first ${word}\nsecond line\n` }, id: "w" }] },
        { toolCalls: [{ name: "edit", args: { path: "notes/a.txt", edits: [{ oldText: word, newText: replacement }] }, id: "e" }] },
        {
          toolCalls: [
            { name: "read", args: { path: "notes/a.txt" }, id: "r" },
            { name: "bash", args: { command: "wc -l < notes/a.txt" }, id: "b" },
          ],
        },
        { text: "done" },
      ];
      const agent = await createAgent({ model: createFauxClient(turns), cwd: dir });
      const { result } = await drain(agent.run("please do it"));
      expect(result.reason).toBe("done");
      expect(await readFile(join(dir, "notes/a.txt"), "utf8")).toBe(`first ${replacement}\nsecond line\n`);
      const messages = await agent.log.project();
      const read = messages.find((message) => message.toolCallId === "r")!;
      expect(textOf(read)).toContain(`first ${replacement}`);
      expect(textOf(messages.find((message) => message.toolCallId === "b")!).trim()).toBe("2");
      expect(textOf(messages.at(-1)!)).toBe("done");
    });
  }

  for (const seed of range(25, 100)) {
    it(`reports tool failures to the model and carries on (seed ${seed})`, async () => {
      const turns: FauxTurn[] = [
        {
          toolCalls: [
            { name: "read", args: { path: `missing${seed}.txt` }, id: "r" },
            { name: "bash", args: { command: `exit ${(seed % 9) + 1}` }, id: "b" },
            { name: "edit", args: { path: "nope", edits: [{ oldText: "a", newText: "b" }] }, id: "e" },
          ],
        },
        { text: "I saw the errors" },
      ];
      const agent = await createAgent({ model: createFauxClient(turns), cwd: dir });
      const { result } = await drain(agent.run("go"));
      expect(result.reason).toBe("done");
      const tools = (await agent.log.project()).filter((message) => message.role === "tool");
      expect(tools.map((message) => message.isError)).toEqual([true, true, true]);
      expect(textOf(tools[0]!)).toContain("File not found");
      expect(textOf(tools[1]!)).toContain(`exited with code ${(seed % 9) + 1}`);
    });
  }

  it("only offers the tools that were enabled", async () => {
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir, tools: ["read"] });
    await drain(agent.run("hi"));
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(client.requests[0]?.system).toContain("- read: ");
    expect(client.requests[0]?.system).not.toContain("- bash: ");
  });

  it("uses a custom system prompt when given", async () => {
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir, system: "Only say ok." });
    await drain(agent.run("hi"));
    expect(client.requests[0]?.system).toBe("Only say ok.");
  });

  it("passes the output limit through", async () => {
    const client = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: client, cwd: dir, maxTokens: 1234 });
    await drain(agent.run("hi"));
    expect(client.requests[0]?.maxTokens).toBe(1234);
  });

  it("sets the thinking level only when asked or when the model needs it", async () => {
    const client = createFauxClient([{ text: "a" }, { text: "b" }]);
    const plain = await createAgent({ model: client, cwd: dir });
    await drain(plain.run("hi"));
    expect(client.requests[0]?.thinking).toBeUndefined();
    const asked = await createAgent({ model: client, cwd: dir, thinking: "high" });
    await drain(asked.run("hi"));
    expect(client.requests[1]?.thinking).toBe("high");
  });

  it("defaults thinking to medium for a model whose compat enables thinking", async () => {
    let body = "";
    const agent = await createAgent({
      cwd: dir,
      model: { baseUrl: "https://example.test", apiKey: "k", model: "m", contextWindow: 200_000, compat: { thinkingFormat: "openai" } },
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      body = String(init.body);
      return new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }) as typeof fetch;
    try {
      await drain(agent.run("hi"));
    } finally {
      globalThis.fetch = original;
    }
    expect(JSON.parse(body)).toMatchObject({ reasoning_effort: "medium" });
  });
});

describe("agent: queue, steer, cancel and follow-up as methods", () => {
  it("queue and steer reach the active run", async () => {
    const client = createFauxClient([{ text: "r1" }, { text: "r2" }]);
    const agent = await createAgent({ model: client, cwd: dir });
    const handle = agent.run("first");
    agent.queue("second");
    await drain(handle);
    expect((await agent.log.project()).map(textOf)).toEqual(["first", "r1", "second", "r2"]);
  });

  it("cancel stops the active run", async () => {
    const agent = await createAgent({ model: createFauxClient([{ hang: true }]), cwd: dir });
    const handle = agent.run("go");
    setTimeout(() => agent.cancel(), 20);
    expect((await drain(handle)).result.reason).toBe("cancelled");
  });

  it("methods do nothing when no run is active", async () => {
    const agent = await createAgent({ model: createFauxClient([]), cwd: dir });
    expect(() => {
      agent.queue("x");
      agent.steer("y");
      agent.cancel();
    }).not.toThrow();
  });

  for (const seed of range(10, 200)) {
    it(`follow-up runs continue the same conversation (seed ${seed})`, async () => {
      const count = 2 + (seed % 4);
      const agent = await createAgent({ model: createFauxClient((request) => ({ text: `saw ${request.messages.length}` })), cwd: dir });
      for (let turn = 0; turn < count; turn++) await drain(agent.run(`q${turn}`));
      const messages = await agent.log.project();
      expect(messages).toHaveLength(count * 2);
      expect(textOf(messages.at(-1)!)).toBe(`saw ${count * 2 - 1}`);
    });
  }
});

describe("agent: session files", () => {
  for (const seed of range(15, 300)) {
    it(`persists the conversation and resumes it in a new agent (seed ${seed})`, async () => {
      const file = join(dir, `sessions/s${seed}.jsonl`);
      const first = await createAgent({ model: createFauxClient([{ text: "one" }]), cwd: dir, sessionFile: file });
      await drain(first.run("hello"));
      await first.close();
      const client = createFauxClient([{ text: "two" }]);
      const second = await createAgent({ model: client, cwd: dir, sessionFile: file });
      await drain(second.run("again"));
      await second.close();
      expect(client.requests[0]?.messages.map(textOf)).toEqual(["hello", "one", "again"]);
      expect((await readFile(file, "utf8")).trim().split("\n").length).toBeGreaterThanOrEqual(5);
    });
  }

  it("refuses a second agent on the same session file", async () => {
    const file = join(dir, "s.jsonl");
    const first = await createAgent({ model: createFauxClient([]), cwd: dir, sessionFile: file });
    await expect(createAgent({ model: createFauxClient([]), cwd: dir, sessionFile: file })).rejects.toThrow("already open");
    await first.close();
  });

  it("recovers a crashed session: a tool call without a result is run again", async () => {
    const file = join(dir, "crash.jsonl");
    await writeFile(join(dir, "data.txt"), "payload");
    const first = await createAgent({ model: createFauxClient([{ toolCalls: [{ name: "read", args: { path: "data.txt" }, id: "c1" }] }, { hang: true }]), cwd: dir, sessionFile: file });
    const handle = first.run("read it");
    await new Promise((done) => setTimeout(done, 50));
    handle.cancel();
    await handle.result;
    await first.close();
    // simulate the crash by dropping the tool result line from the file
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const kept = lines.filter((line) => !line.includes('"role":"tool"'));
    await writeFile(file, `${kept.join("\n")}\n`);
    const client = createFauxClient([{ text: "got it" }]);
    const second = await createAgent({ model: client, cwd: dir, sessionFile: file });
    await drain(second.run());
    expect(textOf(client.requests[0]!.messages.find((message) => message.role === "tool")!)).toBe("payload");
    await second.close();
  });
});

describe("agent: goal and compaction are wired through", () => {
  it("a goal is checked before the agent may stop", async () => {
    const client = createFauxClient((request) => {
      const last = textOf(request.messages.at(-1)!);
      return last.startsWith("You are about to stop.") ? { text: "- [done] x :: y" } : { text: "finished" };
    });
    const agent = await createAgent({ model: client, cwd: dir, goal: { objective: "finish the work" } });
    await drain(agent.run("go"));
    expect(client.requests).toHaveLength(2);
    expect(textOf((await agent.log.project())[0]!)).toContain("finish the work");
  });

  it("compaction can be turned off", async () => {
    const client = createFauxClient((request) => ({ text: "r".repeat(500) + request.messages.length }), { contextWindow: 500 });
    const agent = await createAgent({ model: client, cwd: dir, compaction: false });
    for (let turn = 0; turn < 5; turn++) await drain(agent.run("u".repeat(400)));
    expect((await agent.log.branch()).some((entry) => entry.type === "compaction")).toBe(false);
  });
});

describe("agent: rewinding the conversation", () => {
  it("goes back to an earlier point and the next message starts a new branch", async () => {
    const client = createFauxClient((request) => ({ text: `saw ${request.messages.length}` }));
    const agent = await createAgent({ model: client, cwd: dir });
    await drain(agent.run("first"));
    const mark = (await agent.log.branch()).at(-1)!.id;
    await drain(agent.run("second"));
    agent.rewindTo(mark);
    await drain(agent.run("third"));
    expect((await agent.log.project()).map(textOf)).toEqual(["first", "saw 1", "third", "saw 3"]);
    expect(client.requests.at(-1)!.messages.map(textOf)).toEqual(["first", "saw 1", "third"]);
  });
  it("rewinding to the very start forgets everything on the active branch", async () => {
    const client = createFauxClient([{ text: "a" }, { text: "b" }]);
    const agent = await createAgent({ model: client, cwd: dir });
    await drain(agent.run("one"));
    agent.rewindTo(null);
    await drain(agent.run("two"));
    expect(client.requests[1]!.messages.map(textOf)).toEqual(["two"]);
  });
  it("is saved with a session file: the old branch stays in the file and the new one is restored", async () => {
    const file = join(dir, "r.jsonl");
    const first = await createAgent({ model: createFauxClient([{ text: "a" }, { text: "b" }, { text: "c" }]), cwd: dir, sessionFile: file });
    await drain(first.run("one"));
    const mark = (await first.log.branch()).at(-1)!.id;
    await drain(first.run("two"));
    first.rewindTo(mark);
    await drain(first.run("three"));
    await first.close();
    const second = await createAgent({ model: createFauxClient([]), cwd: dir, sessionFile: file });
    expect((await second.log.project()).map(textOf)).toEqual(["one", "a", "three", "c"]);
    await second.close();
  });
});

describe("options that are handed on", () => {
  const requestsOf = async (config: Partial<Parameters<typeof createAgent>[0]>, script: Parameters<typeof createFauxClient>[0]) => {
    const llm = createFauxClient(script);
    const agent = await createAgent({ model: llm, cwd: dir, ...config });
    for await (const _event of agent.run("hi").events) void _event;
    await agent.close();
    return llm.requests;
  };

  it("maxTokens, thinking and a custom goal prompt reach the model; a sub-agent gets the same limits", async () => {
    const requests = await requestsOf({ maxTokens: 1234, thinking: "high", subAgents: {} }, (request) =>
      request.system.includes("You are a sub-agent")
        ? { text: "child done" }
        : request.messages.at(-1)!.role === "tool"
          ? { text: "parent done" }
          : { toolCalls: [{ id: "d", name: "delegate", args: { message: "go" } }] },
    );
    const parent = requests.find((request) => !request.system.includes("You are a sub-agent"))!;
    const child = requests.find((request) => request.system.includes("You are a sub-agent"))!;
    for (const request of [parent, child]) expect(request).toMatchObject({ maxTokens: 1234, thinking: "high" });
  });

  it("custom prompts replace the built-in goal check", async () => {
    const requests = await requestsOf({ goal: { objective: "x" }, prompts: { goalWrapUp: "CHECK {{objective}} NOW" } }, (request) =>
      textOf(request.messages.at(-1)!).startsWith("CHECK x NOW") ? { text: "- [done] x :: ok" } : { text: "done" },
    );
    expect(requests.some((request) => textOf(request.messages.at(-1)!) === "CHECK x NOW")).toBe(true);
  });

  it("the clock option is used for the entries in the log", async () => {
    const llm = createFauxClient([{ text: "ok" }]);
    const agent = await createAgent({ model: llm, cwd: dir, now: () => 4242 });
    for await (const _event of agent.run("hi").events) void _event;
    expect((await agent.log.project()).every((message) => message.ts === 4242)).toBe(true);
    await agent.close();
  });

  it("compaction can be switched off", async () => {
    const requests = await requestsOf({ compaction: false }, [{ text: "ok" }]);
    expect(requests).toHaveLength(1);
  });
});
