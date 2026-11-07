import { describe, expect, it } from "vitest";
import { createRng } from "@sakura/testing";
import { diffSystem, renderSystem, replaySystem } from "../src/system.ts";
import type { SystemPatch, SystemState } from "../src/system.ts";
import type { LogEntry, ToolDecl } from "../src/index.ts";

const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const decl = (name: string, description = `desc ${name}`, parameters: Record<string, unknown> = { type: "object" }): ToolDecl => ({ name, description, parameters });
const entryOf = (index: number, patch: SystemPatch): LogEntry => ({ id: `e${index}`, parentId: index ? `e${index - 1}` : null, ts: 1, type: "system_patch", ...patch }) as LogEntry;
const apply = (state: SystemState, patch: SystemPatch | undefined, index = 0): SystemState =>
  patch ? replaySystem([...(index ? [entryOf(0, { sections: { system: state.sections.system ?? "" }, toolsAdded: state.tools })] : []), entryOf(index + 1, patch)]) : state;
const empty = (): SystemState => ({ sections: {}, tools: [] });

describe("replaySystem", () => {
  it("is empty for a log without patches", () => {
    expect(replaySystem([])).toEqual(empty());
  });
  it("starts from the first full patch", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "hello" }, toolsAdded: [decl("a"), decl("b")] })]);
    expect(state.sections).toEqual({ system: "hello" });
    expect(state.tools.map((tool) => tool.name)).toEqual(["a", "b"]);
  });
  it("applies patches in order", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "one" }, toolsAdded: [decl("a")] }), entryOf(1, { sections: { system: "two" }, toolsAdded: [decl("b")], toolsRemoved: ["a"] })]);
    expect(state.sections.system).toBe("two");
    expect(state.tools.map((tool) => tool.name)).toEqual(["b"]);
  });
  it("a null section is deleted", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "x", extra: "y" } }), entryOf(1, { sections: { extra: null } })]);
    expect(state.sections).toEqual({ system: "x" });
  });
  it("an added tool with an existing name replaces it and moves to the end", () => {
    const state = replaySystem([entryOf(0, { toolsAdded: [decl("a"), decl("b")] }), entryOf(1, { toolsAdded: [decl("a", "new")] })]);
    expect(state.tools.map((tool) => `${tool.name}:${tool.description}`)).toEqual(["b:desc b", "a:new"]);
  });
  it("ignores other kinds of entries", () => {
    const other = { id: "x", parentId: null, ts: 1, type: "paused", reason: "budget" } as LogEntry;
    expect(replaySystem([other, entryOf(1, { sections: { system: "s" } })]).sections.system).toBe("s");
  });
  it("joins sections in the order they were added", () => {
    expect(renderSystem(replaySystem([entryOf(0, { sections: { system: "A" } }), entryOf(1, { sections: { notes: "B" } })]))).toBe("A\n\nB");
  });
});

describe("diffSystem", () => {
  it("the first patch has everything", () => {
    expect(diffSystem(empty(), { system: "s", tools: [decl("a")] })).toEqual({ sections: { system: "s" }, toolsAdded: [decl("a")] });
  });
  it("nothing to write when nothing changed", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "s" }, toolsAdded: [decl("a")] })]);
    expect(diffSystem(state, { system: "s", tools: [decl("a")] })).toBeUndefined();
  });
  it("a changed system prompt is a section change only", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "s" }, toolsAdded: [decl("a")] })]);
    expect(diffSystem(state, { system: "t", tools: [decl("a")] })).toEqual({ sections: { system: "t" } });
  });
  it("a new tool is added at the end", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "s" }, toolsAdded: [decl("a")] })]);
    expect(diffSystem(state, { system: "s", tools: [decl("a"), decl("b")] })).toEqual({ toolsAdded: [decl("b")] });
  });
  it("a tool that left the configuration stays declared", () => {
    const state = replaySystem([entryOf(0, { sections: { system: "s" }, toolsAdded: [decl("a"), decl("b")] })]);
    expect(diffSystem(state, { system: "s", tools: [decl("a")] })).toBeUndefined();
  });
  for (const change of ["description", "parameters"] as const) {
    it(`a changed ${change} removes and adds the tool again`, () => {
      const state = replaySystem([entryOf(0, { sections: { system: "s" }, toolsAdded: [decl("a"), decl("b")] })]);
      const changed = change === "description" ? decl("a", "other") : decl("a", "desc a", { type: "object", properties: {} });
      expect(diffSystem(state, { system: "s", tools: [changed, decl("b")] })).toEqual({ toolsRemoved: ["a"], toolsAdded: [changed] });
    });
  }
});

describe("random configurations: replaying always gives an add-only superset of what was asked for", () => {
  for (const seed of range(60)) {
    it(`seed ${seed}`, () => {
      const rng = createRng(seed);
      let log: LogEntry[] = [];
      const everAsked = new Map<string, ToolDecl>();
      const order: string[] = [];
      for (let step = 0; step < rng.int(1, 8); step++) {
        const names = ["a", "b", "c", "d", "e"].filter(() => rng.chance(0.6));
        const desired = { system: `prompt ${rng.int(0, 2)}`, tools: names.map((name) => decl(name, `d${rng.int(0, 1)}`)) };
        const state = replaySystem(log);
        const patch = diffSystem(state, desired);
        if (patch) log = [...log, entryOf(log.length, patch)];
        const after = replaySystem(log);
        expect(after.sections.system).toBe(desired.system);
        for (const tool of desired.tools) {
          expect(after.tools.some((declared) => declared.name === tool.name && declared.description === tool.description)).toBe(true);
          if (!everAsked.has(tool.name)) order.push(tool.name);
          everAsked.set(tool.name, tool);
        }
        // idempotent: asking for the same thing again writes nothing
        expect(diffSystem(after, desired)).toBeUndefined();
        // add-only: every tool ever declared is still declared
        for (const name of everAsked.keys()) expect(after.tools.some((declared) => declared.name === name)).toBe(true);
      }
      expect(apply(empty(), undefined)).toEqual(empty());
    });
  }
});
