import { describe, expect, it } from "vitest";
import { createKernel } from "@sakura/kernel";
import type { Environment, LogEntry, Message, Tool } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient } from "@sakura/testing";
import { createReviewer } from "../src/reviewer.ts";
import { resolvePolicy } from "../src/policy.ts";
import { reviewPlugin } from "../src/index.ts";

type Script = Parameters<typeof createFauxClient>[0];
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
const good = (risk = "low", auth = "high", outcome = "allow", rationale = "fine") => ({
  text: JSON.stringify({ risk_level: risk, user_authorization: auth, outcome, rationale }),
  usage: { input: 100, output: 10 },
});
const garbage = { text: "I cannot say", usage: { input: 100, output: 5 } };
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const bash = (command: string, id = "c1") => ({ name: "bash", args: { command }, id });

function harness(reviewer: Script, main: Script, options: { timeoutMs?: number; breaker?: { consecutive: number } } = {}) {
  const executed: string[] = [];
  const bashTool: Tool = {
    name: "bash",
    description: "",
    parameters: { type: "object" },
    effect: "exec",
    replay: "never",
    execute: async (args) => {
      executed.push(String((args as { command: string }).command));
      return { content: [{ type: "text", text: "ran" }] };
    },
  };
  const reviewerLlm = createFauxClient(reviewer);
  const plugin = reviewPlugin({ llm: reviewerLlm, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.breaker ? { breaker: options.breaker } : {}) });
  const llm = createFauxClient(main);
  const kernel = createKernel({ llm, env, system: "s", tools: [bashTool], plugins: [plugin], compaction: false, now: () => 1 });
  const log = createMemoryLog();
  const run = async (input = "go") => {
    const handle = kernel.run(log, input);
    for await (const _ of handle.events) void _;
    return handle.result;
  };
  return { executed, reviewerLlm, llm, log, run };
}
const reviewRecords = async (log: ReturnType<typeof createMemoryLog>) =>
  (await log.branch()).flatMap((entry: LogEntry) => (entry.type === "custom" && entry.customType === "review" ? [entry.data as Record<string, unknown>] : []));
const toolResults = async (log: ReturnType<typeof createMemoryLog>) => (await log.project()).filter((message) => message.role === "tool");

describe("the reviewer: one more try for a technical failure", () => {
  const reviewerFor = (script: Script, timeoutMs = 50) => createReviewer({ llm: createFauxClient(script), policy: resolvePolicy(), timeoutMs });
  const ctx = (signal = new AbortController().signal) => ({ log: createMemoryLog(), signal, tool: () => undefined });
  const call = { id: "c1", name: "bash", args: { command: "npm publish" } };

  it("an unreadable answer and then a good one is the good one, with the cost of both", async () => {
    const reviewer = reviewerFor([garbage, good()]);
    const verdict = await reviewer.review(call, ctx());
    expect(verdict).toMatchObject({ kind: "allow", usage: { input: 200, output: 15 } });
  });
  it("a timeout and then a good answer is the good answer", async () => {
    expect((await reviewerFor([{ hang: true }, good()]).review(call, ctx())).kind).toBe("allow");
  });
  it("an error and then a good answer is the good answer", async () => {
    const error = Object.assign(new Error("overloaded"), { kind: "server" }) as never;
    expect((await reviewerFor([{ error }, good()]).review(call, ctx())).kind).toBe("allow");
  });
  it("an unreadable answer twice is a technical refusal after exactly two requests", async () => {
    const llm = createFauxClient([garbage, garbage, good()]);
    const verdict = await createReviewer({ llm, policy: resolvePolicy() }).review(call, ctx());
    expect(verdict).toMatchObject({ kind: "deny", technical: true, usage: { input: 200 } });
    expect(llm.requests).toHaveLength(2);
  });
  it("a timeout twice is a technical refusal", async () => {
    expect(await reviewerFor([{ hang: true }, { hang: true }]).review(call, ctx())).toMatchObject({ kind: "deny", technical: true });
  });
  it("a real denial is not technical and is not asked again", async () => {
    const llm = createFauxClient([good("critical", "high", "deny", "too dangerous"), good()]);
    const verdict = await createReviewer({ llm, policy: resolvePolicy() }).review(call, ctx());
    expect(verdict).toMatchObject({ kind: "deny", reason: "too dangerous" });
    expect(verdict).not.toHaveProperty("technical");
    expect(llm.requests).toHaveLength(1);
  });
  it("a stopped run is not tried again", async () => {
    const llm = createFauxClient([{ hang: true }, good()]);
    const controller = new AbortController();
    const pending = createReviewer({ llm, policy: resolvePolicy() }).review(call, ctx(controller.signal));
    controller.abort();
    expect(await pending).toMatchObject({ kind: "deny", technical: true });
    expect(llm.requests).toHaveLength(1);
  });
  it("the failed try leaves no trace in the reviewer's conversation", async () => {
    const llm = createFauxClient([garbage, good(), good()]);
    const reviewer = createReviewer({ llm, policy: resolvePolicy() });
    const shared = ctx();
    await reviewer.review(call, shared);
    await reviewer.review({ ...call, id: "c2" }, shared);
    const third = llm.requests[2]!.messages.map(textOf).join("\n");
    expect(third).not.toContain("I cannot say");
    expect(llm.requests[2]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("review records in the conversation log", () => {
  it("an allowed call leaves one review entry and one review usage entry, and the model never sees them", async () => {
    const h = harness([good("low", "high", "allow", "ok to publish")], [{ toolCalls: [bash("npm publish")] }, { text: "done" }]);
    await h.run();
    expect(h.executed).toEqual(["npm publish"]);
    const records = await reviewRecords(h.log);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ callId: "c1", tool: "bash", outcome: "allow", decidedBy: "reviewer", reason: "ok to publish", usage: { input: 100, output: 10 } });
    expect(typeof records[0]!.latencyMs).toBe("number");
    expect((await h.log.branch()).filter((entry) => entry.type === "usage" && entry.kind === "review")).toHaveLength(1);
    expect((await h.log.project()).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(JSON.stringify(h.llm.requests)).not.toContain('"review"');
  });
  it("the requests to the model are the same with and without the records", async () => {
    const withRecords = harness([good()], [{ toolCalls: [bash("npm publish")] }, { text: "done" }]);
    await withRecords.run();
    const messagesOfSecondRequest = withRecords.llm.requests[1]!.messages.map((m) => ({ role: m.role, text: textOf(m) }));
    expect(messagesOfSecondRequest.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(messagesOfSecondRequest[2]!.text).toBe("ran");
  });
  it("a refusal is recorded and keeps the 'do not try again' sentence", async () => {
    const h = harness([good("critical", "low", "deny", "no way")], [{ toolCalls: [bash("npm publish")] }, { text: "done" }]);
    await h.run();
    expect(h.executed).toEqual([]);
    const [result] = await toolResults(h.log);
    expect(textOf(result!)).toContain("no way");
    expect(textOf(result!)).toContain("Do not try the same action again");
    expect(await reviewRecords(h.log)).toMatchObject([{ outcome: "deny", decidedBy: "reviewer" }]);
  });
  it("a hard-rule refusal is recorded with its author and no usage", async () => {
    const h = harness([], [{ toolCalls: [bash("rm -rf /")] }, { text: "done" }]);
    await h.run();
    const [record] = await reviewRecords(h.log);
    expect(record).toMatchObject({ outcome: "deny", tool: "bash" });
    expect(record).not.toHaveProperty("usage");
    expect((await h.log.branch()).some((entry) => entry.type === "usage" && entry.kind === "review")).toBe(false);
  });
  it("a repeated call is decided from memory and recorded as such", async () => {
    const h = harness([good()], [{ toolCalls: [bash("npm publish", "c1")] }, { toolCalls: [bash("npm publish", "c2")] }, { text: "done" }]);
    await h.run();
    expect(h.executed).toEqual(["npm publish", "npm publish"]);
    expect(await reviewRecords(h.log)).toMatchObject([
      { callId: "c1", decidedBy: "reviewer" },
      { callId: "c2", decidedBy: "cache" },
    ]);
    expect(h.reviewerLlm.requests).toHaveLength(1);
  });
  it("parallel calls: each has a record, and the results stay in the order of the calls", async () => {
    const h = harness([good(), good()], [{ toolCalls: [bash("npm publish", "c1"), bash("npm pack", "c2")] }, { text: "done" }]);
    await h.run();
    expect((await reviewRecords(h.log)).map((r) => r.callId).sort()).toEqual(["c1", "c2"]);
    const results = await toolResults(h.log);
    expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
    expect((await h.log.project()).map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
  });
  it("a log with review entries still projects after a compaction entry", async () => {
    const h = harness([good()], [{ toolCalls: [bash("npm publish")] }, { text: "done" }]);
    await h.run();
    const branch = await h.log.branch();
    const lastMessage = [...branch].reverse().find((entry) => entry.type === "message")!;
    await h.log.append({ type: "compaction", summary: "so far", firstKeptEntryId: lastMessage.id, tokensBefore: 10 });
    const projected = await h.log.project();
    expect(projected.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(projected[0]!)).toContain("so far");
  });
});

describe("a review that fails technically", () => {
  it("says so, does not say 'do not try again', and is asked again next time", async () => {
    const h = harness([garbage, garbage, good()], [{ toolCalls: [bash("npm publish", "c1")] }, { toolCalls: [bash("npm publish", "c2")] }, { text: "done" }]);
    await h.run();
    const [first] = await toolResults(h.log);
    expect(first!.isError).toBe(true);
    expect(textOf(first!)).toContain("failed technically");
    expect(textOf(first!)).toContain("Trying the same action again is fine");
    expect(textOf(first!)).not.toContain("Do not try the same action again");
    // the second attempt of the same call is a new review, not a remembered refusal; it runs
    expect(h.executed).toEqual(["npm publish"]);
    expect(await reviewRecords(h.log)).toMatchObject([
      { callId: "c1", outcome: "deny", technical: true, decidedBy: "reviewer" },
      { callId: "c2", outcome: "allow", decidedBy: "reviewer" },
    ]);
    expect(h.reviewerLlm.requests).toHaveLength(3);
  });
  it("still fails closed", async () => {
    const h = harness([garbage, garbage], [{ toolCalls: [bash("npm publish")] }, { text: "done" }]);
    await h.run();
    expect(h.executed).toEqual([]);
  });
  it("counts for the circuit breaker like any refusal", async () => {
    const h = harness([garbage, garbage, garbage, garbage], [{ toolCalls: [bash("npm publish", "c1")] }, { toolCalls: [bash("npm pack", "c2")] }, { text: "done" }], { breaker: { consecutive: 2 } });
    const result = await h.run();
    expect(result.reason).toBe("paused");
  });
});
