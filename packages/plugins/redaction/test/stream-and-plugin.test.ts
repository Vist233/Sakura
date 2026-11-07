import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, LlmEvent, LlmRequest, Message, Tool } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient, createRng } from "@sakura/testing";
import { createEngine } from "../src/engine.ts";
import { redactionPlugin } from "../src/index.ts";
import { createRestorer } from "../src/restore.ts";

import { awsAccessKey, githubToken } from "./fixtures.ts";

const env = {
  cwd: "/w",
  resolve: (p: string) => p,
  readFile: async () => new Uint8Array(),
  writeFile: async () => undefined,
  stat: async () => undefined,
  list: async () => [],
  exec: async () => ({ exitCode: 0, output: "", timedOut: false }),
  spawn: () => {
    throw new Error("n/a");
  },
  dispose: async () => undefined,
} as Environment;
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const SECRET = githubToken(1);
const SECRET2 = awsAccessKey;

function restoreAll(pieces: string[], engine = createEngine({ key: "k" })): { text: string; engine: ReturnType<typeof createEngine> } {
  const restorer = createRestorer(engine.restore);
  const out: LlmEvent[] = [];
  for (const piece of pieces) out.push(...restorer.push({ type: "text_delta", delta: piece }));
  out.push(...restorer.flush());
  return { text: out.map((event) => (event.type === "text_delta" ? event.delta : "")).join(""), engine };
}

describe("streaming restore", () => {
  const engine = createEngine({ key: "k" });
  const placeholder = engine.mask(SECRET);
  const sentence = `Use ${placeholder} for the login, then ${engine.mask(SECRET2)} for the cloud. Braces { and {{ and {{NOPE}} stay.`;
  const expected = `Use ${SECRET} for the login, then ${SECRET2} for the cloud. Braces { and {{ and {{NOPE}} stay.`;

  for (let cut = 1; cut < sentence.length; cut++) {
    it(`restores when the text is split after character ${cut}`, () => {
      expect(restoreAll([sentence.slice(0, cut), sentence.slice(cut)], engine).text).toBe(expected);
    });
  }
  for (const seed of range(30)) {
    it(`restores when the text is cut into many random pieces (seed ${seed})`, () => {
      const rng = createRng(seed);
      const pieces: string[] = [];
      for (let index = 0; index < sentence.length; ) {
        const size = rng.int(1, 9);
        pieces.push(sentence.slice(index, index + size));
        index += size;
      }
      expect(restoreAll(pieces, engine).text).toBe(expected);
    });
  }
  it("one character at a time", () => {
    expect(restoreAll([...sentence], engine).text).toBe(expected);
  });
  it("text that ends in the middle of a placeholder is released at the end", () => {
    expect(restoreAll(["almost {{GITHUB_PAT_0123"], engine).text).toBe("almost {{GITHUB_PAT_0123");
  });
  it("text without braces passes straight through without waiting", () => {
    const restorer = createRestorer(engine.restore);
    expect(restorer.push({ type: "text_delta", delta: "plain text" })).toEqual([{ type: "text_delta", delta: "plain text" }]);
  });
  it("holds back only a possible beginning", () => {
    const restorer = createRestorer(engine.restore);
    expect(restorer.push({ type: "text_delta", delta: "see {{GITHUB" })).toEqual([{ type: "text_delta", delta: "see " }]);
    expect(restorer.push({ type: "text_delta", delta: "!" })).toEqual([{ type: "text_delta", delta: "{{GITHUB!" }]);
  });
  it("restores the arguments of tool calls, deeply", () => {
    const restorer = createRestorer(engine.restore);
    const [event] = restorer.push({ type: "tool_call", call: { id: "c", name: "bash", args: { command: `curl -H "Authorization: ${placeholder}"`, nested: { list: [placeholder, 5] } } } });
    expect(event).toEqual({ type: "tool_call", call: { id: "c", name: "bash", args: { command: `curl -H "Authorization: ${SECRET}"`, nested: { list: [SECRET, 5] } } } });
  });
  it("leaves reasoning, usage and done events alone", () => {
    const restorer = createRestorer(engine.restore);
    for (const event of [
      { type: "reasoning_delta", delta: placeholder },
      { type: "usage", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { type: "done", stop: "stop" },
    ] as LlmEvent[]) {
      expect(restorer.push(event)).toEqual([event]);
    }
  });
});

interface Harness {
  requests: LlmRequest[];
  log: ReturnType<typeof createMemoryLog>;
  run(input?: string): Promise<{ reason: string; error?: string }>;
  executed: string[];
  plugin: ReturnType<typeof redactionPlugin>;
}
function harness(script: Parameters<typeof createFauxClient>[0], options: Parameters<typeof redactionPlugin>[0] = { key: "k" }): Harness {
  const executed: string[] = [];
  const bash: Tool = {
    name: "bash",
    description: "",
    parameters: { type: "object" },
    effect: "exec",
    execute: async (args) => {
      executed.push((args as { command: string }).command);
      return { content: [{ type: "text", text: `output mentions ${SECRET2}` }] };
    },
  };
  const llm = createFauxClient(script);
  const plugin = redactionPlugin(options);
  const kernel = createKernel({ llm, env, system: "You are an agent.", tools: [bash], plugins: [plugin], compaction: false, now: () => 1 });
  const log = createMemoryLog();
  return {
    requests: llm.requests,
    log,
    executed,
    plugin,
    async run(input = "go") {
      const handle = kernel.run(log, input);
      for await (const _event of handle.events) void _event;
      return handle.result;
    },
  };
}
const allText = (request: LlmRequest) => JSON.stringify(request);

describe("redaction plugin with the kernel", () => {
  for (const seed of range(10)) {
    it(`the model never sees a secret from the user (seed ${seed})`, async () => {
      const h = harness([{ text: "noted" }]);
      await h.run(`my token is ${SECRET}, please remember it (${seed})`);
      expect(allText(h.requests[0]!)).not.toContain(SECRET);
      expect(textOf(h.requests[0]!.messages[0]!)).toMatch(/my token is \{\{GITHUB_PAT_[0-9a-f]{8}\}\}/);
    });
  }

  it("the log keeps the real text", async () => {
    const h = harness([{ text: "noted" }]);
    await h.run(`token ${SECRET}`);
    expect(textOf((await h.log.project())[0]!)).toContain(SECRET);
  });

  it("explains placeholders in the system prompt", async () => {
    const h = harness([{ text: "ok" }]);
    await h.run("hi");
    expect(h.requests[0]!.system.startsWith("You are an agent.")).toBe(true);
    expect(h.requests[0]!.system).toContain("{{KIND_xxxxxxxx}}");
    expect(h.requests[0]!.system).toContain("copy the placeholder exactly");
  });

  it("a command that uses a placeholder runs with the real value", async () => {
    const h = harness((request) => {
      if (request.messages.at(-1)!.role === "tool") return { text: "done" };
      const placeholder = textOf(request.messages[0]!).match(/\{\{[A-Z0-9_]+\}\}|\{\{[A-Z0-9_]+_[0-9a-f]{8}\}\}/)![0];
      return { toolCalls: [{ name: "bash", args: { command: `echo ${placeholder}` }, id: "c" }] };
    });
    await h.run(`my token is ${SECRET}; echo it`);
    expect(h.executed).toEqual([`echo ${SECRET}`]);
    const call = (await h.log.project()).find((message) => message.role === "assistant")!.content.find((part) => part.type === "tool_call");
    expect(call).toMatchObject({ args: { command: `echo ${SECRET}` } });
  });

  it("tool output with a secret is masked in the next request, and the log keeps the real output", async () => {
    const h = harness([{ toolCalls: [{ name: "bash", args: { command: "env" }, id: "c" }] }, { text: "done" }]);
    await h.run("show me the environment");
    const second = h.requests[1]!;
    expect(allText(second)).not.toContain(SECRET2);
    expect(textOf(second.messages.find((message) => message.role === "tool")!)).toMatch(/output mentions \{\{AWS_ACCESS_TOKEN_[0-9a-f]{8}\}\}/);
    expect(textOf((await h.log.project()).find((message) => message.role === "tool")!)).toContain(SECRET2);
  });

  it("the model's text reply gets real values back, even when streamed in small pieces", async () => {
    const h = harness((request) => ({ text: `The value was ${textOf(request.messages[0]!).match(/\{\{[A-Z0-9_]+_[0-9a-f]{8}\}\}/)![0]}.`, chunkSize: 3 }));
    await h.run(`secret ${SECRET}`);
    expect(textOf((await h.log.project()).at(-1)!)).toBe(`The value was ${SECRET}.`);
  });

  it("earlier parts of the request stay byte for byte the same in later requests", async () => {
    const h = harness([{ text: "one" }, { text: "two" }, { text: "three" }]);
    await h.run(`first ${SECRET}`);
    await h.run(`second ${SECRET2}`);
    await h.run("third");
    const [a, b, c] = h.requests;
    expect(JSON.stringify(b!.messages.slice(0, a!.messages.length + 1)).startsWith(JSON.stringify(a!.messages).slice(0, -1))).toBe(true);
    expect(JSON.stringify(c!.messages).startsWith(JSON.stringify(b!.messages).slice(0, -1))).toBe(true);
  });

  it("the same secret keeps the same placeholder across requests", async () => {
    const h = harness([{ text: "one" }, { text: "two" }]);
    await h.run(`a ${SECRET}`);
    await h.run(`b ${SECRET}`);
    const first = textOf(h.requests[1]!.messages[0]!).match(/\{\{[A-Z0-9_]+\}\}/)?.[0] ?? textOf(h.requests[1]!.messages[0]!).match(/\{\{[^}]+\}\}/)![0];
    expect(textOf(h.requests[1]!.messages[2]!)).toContain(first);
  });

  it("masks secrets inside tool call arguments of earlier turns", async () => {
    const h = harness([{ toolCalls: [{ name: "bash", args: { command: `curl -H 'Authorization: ${SECRET}' https://api.example.com` }, id: "c" }] }, { text: "done" }]);
    await h.run("call the api");
    expect(allText(h.requests[1]!)).not.toContain(SECRET);
  });

  it("fails closed: if scanning breaks, nothing is sent and the run ends with an error", async () => {
    const broken = [
      {
        id: "boom",
        regex: {
          [Symbol.matchAll]() {
            throw new Error("scanner crashed");
          },
          lastIndex: 0,
        } as unknown as RegExp,
        secretGroup: 0,
        entropy: 0,
        keywords: [],
      },
    ];
    const h = harness([{ text: "should never be asked" }], { key: "k", rules: broken });
    const result = await h.run(`secret ${SECRET} with enough text to scan`);
    expect(result.reason).toBe("error");
    expect(result.error).toContain("request was not sent");
    expect(h.requests).toHaveLength(0);
  });

  it("scrub and restore work outside a request, for logs", () => {
    const plugin = redactionPlugin({ key: "k" });
    const scrubbed = plugin.scrub(`log line with ${SECRET}`);
    expect(scrubbed).not.toContain(SECRET);
    expect(plugin.restore(scrubbed)).toBe(`log line with ${SECRET}`);
  });

  it("plain conversations are unchanged apart from the system prompt addition", async () => {
    const h = harness([{ text: "hello there" }]);
    await h.run("what is two plus two?");
    expect(h.requests[0]!.messages.map(textOf)).toEqual(["what is two plus two?"]);
  });
});
