import { describe, expect, it } from "vitest";
import { finish, setup, textOf } from "./helpers.ts";

// A screen shows "thinking" while a reasoning model works, so the reasoning text is an event. It is only for showing: it is not put in the log
// and not in the next request.
describe("reasoning text is an event", () => {
  it("is sent as reasoning_update before the answer, and the answer still comes as message_update", async () => {
    const { kernel, log } = setup({ script: [{ reasoning: "Let me think. 2 + 2 is 4.", text: "four", chunkSize: 5 }] });
    const { events } = await finish(kernel.run(log, "2+2?"));
    const kinds = events.map((event) => event.type).filter((type) => type === "reasoning_update" || type === "message_update" || type === "message_start");
    expect(kinds[0]).toBe("message_start");
    expect(kinds.indexOf("reasoning_update")).toBeLessThan(kinds.indexOf("message_update"));
    const thought = events.flatMap((event) => (event.type === "reasoning_update" ? [event.delta] : [])).join("");
    expect(thought).toBe("Let me think. 2 + 2 is 4.");
  });

  it("is not kept in the conversation", async () => {
    const built = setup({ script: [{ reasoning: "secret thoughts", text: "four" }, { text: "again" }] });
    await finish(built.kernel.run(built.log, "2+2?"));
    await finish(built.kernel.run(built.log, "and more?"));
    expect(JSON.stringify(await built.log.branch())).not.toContain("secret thoughts");
    expect(JSON.stringify(built.llm.requests.at(-1))).not.toContain("secret thoughts");
    expect((await built.log.project()).map(textOf)).toContain("four");
  });
});
