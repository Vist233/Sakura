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

describe("watch: the wish to wake the agent", () => {
  /** A tool that watches with the given options. */
  function watching(options: { wake?: boolean } | undefined, onFinish: (finishWork: (text: string) => void) => void): Tool {
    return {
      name: "start",
      description: "",
      parameters: {},
      effect: "read",
      execute: async (_args, context: ToolContext) => {
        onFinish(options === undefined ? context.watch("job") : context.watch("job", options));
        return { content: text("started") };
      },
    };
  }

  for (const [label, options, expected] of [
    ["left out", undefined, undefined],
    ["wanted", { wake: true }, { wake: true }],
    ["not wanted", { wake: false }, { wake: false }],
    ["an empty options object", {}, undefined],
  ] as const) {
    it(`onSignal is told when waking is ${label}`, async () => {
      let end: ((text: string) => void) | undefined;
      const seen: Array<{ text: string; options: unknown }> = [];
      const built = setup({
        script: [callStart, { text: "waiting" }],
        tools: [watching(options, (finishWork) => (end = finishWork))],
        onSignal: (_log, signal, signalOptions) => seen.push({ text: signal, options: signalOptions }),
      });
      await finish(built.kernel.run(built.log, "go"));
      end!("ended");
      expect(seen).toEqual([{ text: "ended", options: expected }]);
    });
  }

  it("the wish is passed on whether or not a run is going", async () => {
    let end: ((text: string) => void) | undefined;
    const seen: unknown[] = [];
    const built = setup({ script: [callStart, { text: "waiting" }], tools: [watching({ wake: true }, (finishWork) => (end = finishWork))], onSignal: (_log, _text, options) => seen.push(options) });
    const handle = built.kernel.run(built.log, "go");
    await handle.result;
    end!("later");
    expect(seen).toEqual([{ wake: true }]);
  });

  it("the signal reaches the agent the same way whatever was asked", async () => {
    for (const options of [undefined, { wake: true }, { wake: false }] as const) {
      let end: ((text: string) => void) | undefined;
      const built = setup({ script: [callStart, { text: "waiting" }], tools: [watching(options, (finishWork) => (end = finishWork))] });
      await finish(built.kernel.run(built.log, "go"));
      end!("the job ended");
      expect(built.kernel.pending(built.log).signals).toEqual(["the job ended"]);
    }
  });

  it("notify has no wish and says so", async () => {
    const seen: unknown[] = [];
    const notifier: Tool = { name: "start", description: "", parameters: {}, effect: "read", execute: async (_args, context) => (context.notify("something changed"), { content: text("ok") }) };
    const built = setup({ script: [callStart, { text: "done" }], tools: [notifier], onSignal: (_log, _text, options) => seen.push(options) });
    await finish(built.kernel.run(built.log, "go"));
    expect(seen).toEqual([undefined]);
  });

  it("the report of the end can change the wish for that ending", async () => {
    for (const [asked, ending, expected] of [
      [true, { wake: false }, { wake: false }],
      [false, { wake: true }, { wake: true }],
      [undefined, { wake: false }, { wake: false }],
      [true, undefined, { wake: true }],
      [true, {}, { wake: true }],
    ] as const) {
      let end: ((text: string, ending?: { wake?: boolean }) => void) | undefined;
      const seen: unknown[] = [];
      const tool: Tool = {
        name: "start",
        description: "",
        parameters: {},
        effect: "read",
        execute: async (_args, context: ToolContext) => {
          end = asked === undefined ? context.watch("job") : context.watch("job", { wake: asked });
          return { content: text("started") };
        },
      };
      const built = setup({ script: [callStart, { text: "waiting" }], tools: [tool], onSignal: (_log, _text, options) => seen.push(options) });
      await finish(built.kernel.run(built.log, "go"));
      end!("ended", ending);
      expect(seen).toEqual([expected]);
    }
  });
});
