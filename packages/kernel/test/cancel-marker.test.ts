import { describe, expect, it } from "vitest";
import { delay, finish, roles, setup, text, textOf, tool } from "./helpers.ts";

// A cancelled request must not stay in the conversation as if it were still waiting for an answer: the next message would be answered together with it.
// So a cancel ends with a short assistant note, and the history is complete.
const slow = () => tool("slow", () => new Promise((resolve) => setTimeout(() => resolve({ content: text("late") }), 200)), { effect: "write" });

describe("a cancelled run leaves a note that it was interrupted", () => {
  it("when the model was still answering", async () => {
    const { kernel, log } = setup({ script: [{ hang: true }] });
    const handle = kernel.run(log, "write a long essay");
    await delay(5);
    handle.cancel();
    expect((await finish(handle)).result.reason).toBe("cancelled");
    expect(await roles(log)).toEqual(["user", "assistant"]);
    expect(textOf((await log.project()).at(-1)!)).toMatch(/interrupted/i);
  });

  it("when tools were running, after the results that say they were cancelled", async () => {
    const { kernel, log } = setup({ script: [{ toolCalls: [{ name: "slow", args: {}, id: "c1" }] }, { text: "never" }], tools: [slow()] });
    const handle = kernel.run(log, "go");
    await delay(30);
    handle.cancel();
    await finish(handle);
    expect(await roles(log)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("so the next message is not answered together with the cancelled one", async () => {
    const built = setup({ script: [{ hang: true }, { text: "second answer" }] });
    const handle = built.kernel.run(built.log, "write a long essay");
    await delay(5);
    handle.cancel();
    await finish(handle);
    await finish(built.kernel.run(built.log, "which file did I ask for?"));
    const sent = built.llm.requests.at(-1)!.messages;
    expect(sent.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(sent[1]!)).toMatch(/interrupted/i);
  });

  it("and running again with nothing new does not send the cancelled request to the model again", async () => {
    const built = setup({ script: [{ hang: true }, { text: "should not be asked" }] });
    const handle = built.kernel.run(built.log, "write a long essay");
    await delay(5);
    handle.cancel();
    await finish(handle);
    const before = built.llm.requests.length;
    expect((await finish(built.kernel.run(built.log))).result.reason).toBe("done");
    expect(built.llm.requests.length).toBe(before);
  });

  it("only once, and not when the conversation already ends with an answer", async () => {
    const built = setup({ script: [{ text: "all done" }] });
    const handle = built.kernel.run(built.log, "hi");
    await finish(handle);
    handle.cancel();
    expect(await roles(built.log)).toEqual(["user", "assistant"]);
    expect(textOf((await built.log.project()).at(-1)!)).toBe("all done");
  });
});
