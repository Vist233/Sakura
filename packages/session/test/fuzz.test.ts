import { describe, expect, it } from "vitest";
import type { LogEntry } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { projectMessages } from "../src/projection.ts";
import { entry, messageEntry, text, textOf } from "./helpers.ts";

// Random logs mixing messages, hidden bookkeeping entries and edits. The expected result is
// built alongside the log, independently of the projection code.
describe("projection: mixed random logs", () => {
  for (let seed = 1; seed <= 30; seed++) {
    it(`matches the expectation built with the log (seed ${seed})`, () => {
      const rng = createRng(seed * 7919);
      const entries: LogEntry[] = [];
      const expected = new Map<string, string | null>();
      const order: string[] = [];
      let parent: string | null = null;
      for (let index = 1; index <= rng.int(5, 40); index++) {
        const id = `n${index}`;
        const kind = rng.int(0, 9);
        if (kind <= 4) {
          const value = `v${rng.int(0, 99999)}`;
          entries.push(messageEntry(id, parent, index % 2 ? "user" : "assistant", value));
          expected.set(id, value);
          order.push(id);
        } else if (kind <= 6) {
          entries.push(entry(id, parent, { type: "usage", kind: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }));
        } else if (kind === 7 && order.length > 0) {
          const target = rng.pick(order);
          const remove = rng.chance(0.4);
          entries.push(entry(id, parent, { type: "context_edit", targetId: target, replacement: remove ? null : text(`edit${index}`) }));
          expected.set(target, remove ? null : `edit${index}`);
        } else {
          entries.push(entry(id, parent, { type: "custom", customType: "c", data: index }));
        }
        parent = id;
      }
      const want = order.flatMap((id) => (expected.get(id) === null ? [] : [expected.get(id)]));
      expect(projectMessages(entries).map(textOf)).toEqual(want);
    });
  }
});
