import { describe, expect, it } from "vitest";
import type { Tool, ToolContext } from "../src/index.ts";
import { finish, setup, text, textOf } from "./helpers.ts";

/** A tool that starts background work and hands the "it ended" callback to the test. */
function starter(onFinish: (finishWork: (text: string) => void) => void, label = "job"): Tool {
  return {
    name: "start",
    description: "",
    parameters: {},
    effect: "read",
    execute: async (_args, context: ToolContext) => {
      onFinish(context.watch(label));
      return { content: text("started") };
    },
  };
}
const callStart = { toolCalls: [{ name: "start", args: {}, id: "c" }] };

describe("watch: background work the agent waits for", () => {
  it("counts as pending until it ends, and its end becomes a signal", async () => {
    let end: ((text: string) => void) | undefined;
    const built = setup({ script: [callStart, { text: "waiting" }], tools: [starter((finishWork) => (end = finishWork), "build")] });
    await finish(built.kernel.run(built.log, "go"));
    expect(built.kernel.pending(built.log)).toEqual({ signals: [], watching: ["build"] });
    end!("build finished");
    expect(built.kernel.pending(built.log)).toEqual({ signals: ["build finished"], watching: [] });
  });

  it("finishing twice reports once", async () => {
    let end: ((text: string) => void) | undefined;
    const built = setup({ script: [callStart, { text: "waiting" }], tools: [starter((finishWork) => (end = finishWork))] });
    await finish(built.kernel.run(built.log, "go"));
    end!("one");
    end!("two");
    expect(built.kernel.pending(built.log).signals).toEqual(["one"]);
  });

  it("calls onSignal even after the run has ended, so a host can wake the agent", async () => {
    let end: ((text: string) => void) | undefined;
    const seen: string[] = [];
    const built = setup({ script: [callStart, { text: "waiting" }], tools: [starter((finishWork) => (end = finishWork))], onSignal: (_log, signal) => seen.push(signal) });
    await finish(built.kernel.run(built.log, "go"));
    end!("done now");
    expect(seen).toEqual(["done now"]);
  });

  it("a run without input tells the agent what happened and the model answers", async () => {
    let end: ((text: string) => void) | undefined;
    const built = setup({ script: [callStart, { text: "waiting" }, { text: "thanks, noted" }], tools: [starter((finishWork) => (end = finishWork))] });
    await finish(built.kernel.run(built.log, "go"));
    end!("the job ended");
    const { result } = await finish(built.kernel.run(built.log));
    expect(result.reason).toBe("done");
    const last = built.llm.requests.at(-1)!.messages.at(-1)!;
    expect(textOf(last)).toContain("the job ended");
    expect(built.kernel.pending(built.log).signals).toEqual([]);
  });

  it("a run without input and nothing pending ends at once without a request", async () => {
    const built = setup({ script: [{ text: "hi" }] });
    await finish(built.kernel.run(built.log, "go"));
    const before = built.llm.requests.length;
    const { result } = await finish(built.kernel.run(built.log));
    expect(result.reason).toBe("done");
    expect(built.llm.requests.length).toBe(before);
  });

  it("pending is kept per conversation", async () => {
    let end: ((text: string) => void) | undefined;
    const first = setup({ script: [callStart, { text: "w" }], tools: [starter((finishWork) => (end = finishWork))] });
    await finish(first.kernel.run(first.log, "go"));
    const other = setup({ script: [{ text: "x" }] });
    expect(other.kernel.pending(other.log)).toEqual({ signals: [], watching: [] });
    expect(end).toBeDefined();
  });
});
