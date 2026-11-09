import { describe, expect, it } from "vitest";
import type { Event } from "../src/index.ts";
import { delay, finish, setup, text, tool } from "./helpers.ts";

// What a screen needs to follow a run: when a reply starts (before its first word), and when a message the user sent during the run was taken.
const types = (events: Event[]) => events.map((event) => event.type);

describe("message_start comes before the first word of a reply", () => {
  it("for a reply with text: start, updates, end", async () => {
    const { kernel, log } = setup({ script: [{ text: "hello there" }] });
    const { events } = await finish(kernel.run(log, "hi"));
    const order = types(events).filter((type) => type.startsWith("message_"));
    expect(order[0]).toBe("message_end"); // the user's own message
    expect(order.slice(1)).toEqual(["message_start", ...order.slice(2, -1), "message_end"]);
    expect(order.slice(2, -1).every((type) => type === "message_update")).toBe(true);
    expect(order.slice(2, -1).length).toBeGreaterThan(0);
  });

  it("for a reply that is only a tool call: start, then end, once each", async () => {
    const echo = tool("echo", () => ({ content: text("ok") }), { effect: "read" });
    const { kernel, log } = setup({ script: [{ toolCalls: [{ name: "echo", args: {}, id: "e" }] }, { text: "done" }], tools: [echo] });
    const { events } = await finish(kernel.run(log, "go"));
    const starts = events.filter((event) => event.type === "message_start");
    const ends = events.filter((event) => event.type === "message_end" && event.message.role === "assistant");
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    const firstStart = types(events).indexOf("message_start");
    const firstAssistantEnd = events.findIndex((event) => event.type === "message_end" && event.message.role === "assistant");
    expect(firstStart).toBeLessThan(firstAssistantEnd);
  });
});

describe("a message sent during the run is announced when the agent takes it", () => {
  const slow = () => tool("slow", async () => (await delay(80), { content: text("late") }), { effect: "read" });
  const script = [{ toolCalls: [{ name: "slow", args: {}, id: "s" }] }, { text: "first answer" }, { text: "second answer" }];

  it("steer", async () => {
    const { kernel, log } = setup({ script, tools: [slow()] });
    const handle = kernel.run(log, "go");
    await delay(20);
    handle.steer("also do this");
    const { events } = await finish(handle);
    const taken = events.filter((event) => event.type === "message_end" && event.message.role === "user");
    expect(taken.map((event) => (event.type === "message_end" ? event.message.content : []))).toEqual([[{ type: "text", text: "go" }], [{ type: "text", text: "also do this" }]]);
  });

  it("queue", async () => {
    const { kernel, log } = setup({ script, tools: [slow()] });
    const handle = kernel.run(log, "go");
    await delay(20);
    handle.queue("and then this");
    const { events } = await finish(handle);
    const taken = events.filter((event) => event.type === "message_end" && event.message.role === "user");
    expect(taken).toHaveLength(2);
    expect(taken[1]).toMatchObject({ message: { content: [{ type: "text", text: "and then this" }] } });
  });
});
