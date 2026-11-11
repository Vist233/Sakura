import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUpdateMapper } from "../../src/acp/events-to-updates.ts";
import type { Event } from "../../src/framework.ts";

const ended: Event = { type: "message_end", message: { role: "assistant", content: [], ts: 0 } };
const text = (value: string): Event => ({ type: "message_update", delta: { type: "text", text: value } });
const thought = (value: string): Event => ({ type: "reasoning_update", delta: value });
const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const run = (events: Event[]) => {
  const mapper = createUpdateMapper(counter());
  return events.flatMap((event) => mapper.push(event));
};

describe("events to updates (L1)", () => {
  it("maps text and reasoning deltas to chunks, each kind with its own message id", () => {
    assert.deepEqual(run([thought("hm"), text("a"), text("b")]), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" }, messageId: "id-1" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" }, messageId: "id-2" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" }, messageId: "id-2" },
    ]);
  });

  it("starts a new message after a reply ends", () => {
    const ids = run([text("a"), ended, text("b")]).map((update) => update.messageId);
    assert.deepEqual(ids, ["id-1", "id-2"]);
  });

  it("a reply that is sent again gets a new id; the earlier chunks stay as they were", () => {
    const updates = run([text("part"), { type: "message_reset" }, text("whole")]);
    assert.deepEqual(updates.map((update) => [update.content.text, update.messageId]), [["part", "id-1"], ["whole", "id-2"]]);
  });

  it("ignores events that have no counterpart yet and empty deltas", () => {
    const ignored: Event[] = [{ type: "run_start" }, { type: "turn_start" }, { type: "compaction", tokensBefore: 5 }, { type: "paused", reason: "approval" }, text(""), thought(""), { type: "message_update", delta: { type: "image", mediaType: "image/png", ref: "x" } }];
    assert.deepEqual(run(ignored), []);
  });

  it("property: random event sequences never throw, ids are stable within a reply and never reused after it ends", () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pool: Event[] = [text("x"), text("yy"), thought("t"), text(""), ended, { type: "message_reset" }, { type: "tool_start", call: { id: "1", name: "bash", args: {} } }, { type: "run_end", reason: "done" }];
    for (let round = 0; round < 300; round++) {
      const events = Array.from({ length: 1 + Math.floor(random() * 30) }, () => pool[Math.floor(random() * pool.length)]!);
      const mapper = createUpdateMapper(counter());
      const seen = new Map<string, "agent_message_chunk" | "agent_thought_chunk">();
      let current = new Set<string>();
      for (const event of events) {
        const updates = mapper.push(event);
        for (const update of updates) {
          const kind = update.sessionUpdate;
          if (seen.has(update.messageId)) assert.equal(seen.get(update.messageId), kind, "one id never serves both kinds");
          seen.set(update.messageId, kind);
          current.add(update.messageId);
        }
        if (event.type === "message_end" || event.type === "message_reset") {
          const before = new Set(current);
          current = new Set();
          for (const update of mapper.push(text("again"))) assert.ok(!before.has(update.messageId), "an id is not reused after the reply ended");
          mapper.push({ type: "message_reset" });
        }
      }
    }
  });
});
