import { describe, expect, it } from "vitest";
import { FatalHookError } from "../src/index.ts";
import type { EventTransform, LlmEvent, LlmRequest, Plugin } from "../src/index.ts";
import { runOnce, textOf } from "./helpers.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const plugin = (name: string, setupFn: Plugin["setup"]): Plugin => ({ name, setup: setupFn });
const upper: EventTransform = { push: (event) => [event.type === "text_delta" ? { ...event, delta: event.delta.toUpperCase() } : event], flush: () => [] };

describe("request hooks that return a transform for the reply", () => {
  for (const chunk of range(5)) {
    it(`rewrites streamed text (chunk size ${chunk})`, async () => {
      const p = plugin("shout", (api) => api.on("request", (request) => ({ request, transform: upper })));
      const { log } = await runOnce({ script: [{ text: "hello world", chunkSize: chunk }], plugins: [p] });
      expect(textOf((await log.project())[1]!)).toBe("HELLO WORLD");
    });
  }

  it("can hold events back and release them at the end", async () => {
    const holding: EventTransform = (() => {
      let held = "";
      return {
        push: (event: LlmEvent) => {
          if (event.type !== "text_delta") return [event];
          held += event.delta;
          return [];
        },
        flush: () => (held ? [{ type: "text_delta" as const, delta: `[${held}]` }] : []),
      };
    })();
    const p = plugin("hold", (api) => api.on("request", (request) => ({ request, transform: holding })));
    const { log } = await runOnce({ script: [{ text: "abc", chunkSize: 1 }], plugins: [p] });
    expect(textOf((await log.project())[1]!)).toBe("[abc]");
  });

  it("transforms apply in plugin order", async () => {
    const add = (mark: string): EventTransform => ({ push: (event) => [event.type === "text_delta" ? { ...event, delta: `${event.delta}${mark}` } : event], flush: () => [] });
    const a = plugin("a", (api) => api.on("request", (request) => ({ request, transform: add("1") })));
    const b = plugin("b", (api) => api.on("request", (request) => ({ request, transform: add("2") })));
    const { log } = await runOnce({ script: [{ text: "x" }], plugins: [a, b] });
    expect(textOf((await log.project())[1]!)).toBe("x12");
  });

  it("can change tool call arguments before they run", async () => {
    let seen: unknown;
    const rewrite: EventTransform = { push: (event) => [event.type === "tool_call" ? { ...event, call: { ...event.call, args: { replaced: true } } } : event], flush: () => [] };
    const p = plugin("rewrite", (api) => api.on("request", (request) => ({ request, transform: rewrite })));
    const tool = {
      name: "t",
      description: "",
      parameters: {},
      effect: "read" as const,
      execute: async (args: unknown) => {
        seen = args;
        return { content: [] };
      },
    };
    await runOnce({ script: [{ toolCalls: [{ name: "t", args: { original: 1 }, id: "c" }] }, { text: "d" }], tools: [tool], plugins: [p] });
    expect(seen).toEqual({ replaced: true });
  });

  it("a hook can still return just a request, or nothing", async () => {
    const a = plugin("a", (api) => api.on("request", (request) => ({ ...request, maxTokens: 9 })));
    const b = plugin("b", (api) => api.on("request", () => undefined));
    const { llm } = await runOnce({ script: [{ text: "x" }], plugins: [a, b] });
    expect(llm.requests[0]?.maxTokens).toBe(9);
  });

  it("the transform also covers the side requests (compaction and goal checks)", async () => {
    let asked = 0;
    const counting: EventTransform = {
      push: (event) => {
        if (event.type === "text_delta") asked++;
        return [event];
      },
      flush: () => [],
    };
    const p = plugin("count", (api) => api.on("request", (request) => ({ request, transform: counting })));
    await runOnce({
      script: (request: LlmRequest) => ({ text: textOf(request.messages.at(-1)!).startsWith("You are about to stop") ? "- [done] x :: y" : "work" }),
      goal: { objective: "g" },
      plugins: [p],
    } as never);
    expect(asked).toBeGreaterThanOrEqual(2);
  });
});

describe("FatalHookError", () => {
  for (const hook of ["request", "context"] as const) {
    it(`from a ${hook} hook stops the run and nothing is sent`, async () => {
      const p = plugin("strict", (api) =>
        api.on(hook, (() => {
          throw new FatalHookError("must not continue");
        }) as never),
      );
      const { result, llm } = await runOnce({ script: [{ text: "never" }], plugins: [p] });
      expect(result).toEqual({ reason: "error", error: "must not continue" });
      expect(llm.requests).toHaveLength(0);
    });
  }
  it("an ordinary error in the same hook is still skipped", async () => {
    const p = plugin("sloppy", (api) =>
      api.on("request", () => {
        throw new Error("oops");
      }),
    );
    const { result } = await runOnce({ script: [{ text: "ok" }], plugins: [p] });
    expect(result.reason).toBe("done");
  });
  it("is an Error with its own name", () => {
    const error = new FatalHookError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FatalHookError");
  });
});
