// Exact-value tests added after mutation testing (Stryker) found survivors in goal.ts and system.ts.
import { describe, expect, it } from "vitest";
import { describeRemaining, judgeChecklist, newGoal, parseChecklist } from "../src/goal.ts";
import { diffSystem, renderSystem, replaySystem } from "../src/system.ts";
import type { LogEntry, ToolDecl } from "../src/index.ts";

describe("parseChecklist: the line format", () => {
  const cases: Array<[string, Array<{ status: string; text: string; note: string }>]> = [
    ["- [done] write code :: tests pass", [{ status: "done", text: "write code", note: "tests pass" }]],
    ["* [todo] fix bug", [{ status: "todo", text: "fix bug", note: "" }]],
    ["[human] pick a name", [{ status: "human", text: "pick a name", note: "" }]],
    ["   - [DONE] Upper case status", [{ status: "done", text: "Upper case status", note: "" }]],
    ["-[todo]no space", [{ status: "todo", text: "no space", note: "" }]],
    ["- [done]    lots of space   ::   spaced note  ", [{ status: "done", text: "lots of space", note: "spaced note" }]],
    ["- [done] a :: b :: c", [{ status: "done", text: "a", note: "b" }]],
    ["- [doing] unknown status", []],
    ["done: not a checklist line", []],
    ["text before - [done] item", []],
    ["- [done]", [{ status: "done", text: "", note: "" }]],
  ];
  for (const [line, expected] of cases) {
    it(`${JSON.stringify(line)}`, () => expect(parseChecklist(line)).toEqual(expected));
  }

  it("keeps several lines in order and ignores the others", () => {
    const parsed = parseChecklist("Here is the list:\n- [done] a\n\nsome words\n- [todo] b :: later\n");
    expect(parsed.map((item) => `${item.status}:${item.text}:${item.note}`)).toEqual(["done:a:", "todo:b:later"]);
  });

  it("the status word must be followed by the closing bracket and the text must not start glued to garbage", () => {
    expect(parseChecklist("- [done]x")).toEqual([{ status: "done", text: "x", note: "" }]);
    expect(parseChecklist("- [donee] x")).toEqual([]);
  });
});

describe("judgeChecklist", () => {
  const item = (status: "done" | "todo" | "human", text = "t") => ({ status, text, note: "" });
  it("an empty checklist is not a pass: it asks for a readable list", () => {
    const verdict = judgeChecklist([]);
    expect(verdict.kind).toBe("continue");
    expect(verdict.kind === "continue" && verdict.remaining).toHaveLength(1);
    expect(verdict.kind === "continue" && verdict.remaining[0]?.status).toBe("todo");
    expect(verdict.kind === "continue" && verdict.remaining[0]?.text).toContain("could not be read");
  });
  it("any todo means continue, listing only the todo items", () => {
    expect(judgeChecklist([item("done"), item("todo", "a"), item("human", "b")])).toEqual({ kind: "continue", remaining: [item("todo", "a")] });
  });
  it("no todo but a human item needs a human, listing only those", () => {
    expect(judgeChecklist([item("done"), item("human", "b")])).toEqual({ kind: "needs_human", remaining: [item("human", "b")] });
  });
  it("all done is complete", () => {
    expect(judgeChecklist([item("done"), item("done")])).toEqual({ kind: "complete" });
  });
});

describe("goal helpers", () => {
  it("describeRemaining writes one line per item, with the note in brackets only when there is one", () => {
    expect(
      describeRemaining([
        { status: "todo", text: "a", note: "" },
        { status: "todo", text: "b", note: "why" },
      ]),
    ).toBe("- a\n- b (why)");
  });
  it("newGoal starts active with no human streak, and only has verify when given", () => {
    expect(newGoal("ship")).toEqual({ objective: "ship", status: "active", humanStreak: 0 });
    expect(newGoal("ship", "run tests")).toEqual({ objective: "ship", verify: "run tests", status: "active", humanStreak: 0 });
    expect("verify" in newGoal("ship")).toBe(false);
  });
});

const decl = (name: string, description = "d", parameters: Record<string, unknown> = {}): ToolDecl => ({ name, description, parameters });
const patchEntry = (id: string, body: Partial<Extract<LogEntry, { type: "system_patch" }>>): LogEntry => ({ id, parentId: null, ts: 1, type: "system_patch", ...body }) as LogEntry;

describe("replaySystem", () => {
  it("ignores entries that are not patches", () => {
    const entries: LogEntry[] = [{ id: "m", parentId: null, ts: 1, type: "custom", customType: "x", data: 1 }, patchEntry("p", { sections: { system: "S" } })];
    expect(replaySystem(entries).sections).toEqual({ system: "S" });
  });
  it("null removes a section; a later value replaces an earlier one", () => {
    const state = replaySystem([patchEntry("a", { sections: { system: "one", extra: "x" } }), patchEntry("b", { sections: { system: "two", extra: null } })]);
    expect(state.sections).toEqual({ system: "two" });
  });
  it("tools are added, replaced by name (moving to the end) and removed", () => {
    const state = replaySystem([patchEntry("a", { toolsAdded: [decl("x"), decl("y")] }), patchEntry("b", { toolsAdded: [decl("x", "new")] }), patchEntry("c", { toolsRemoved: ["y"] })]);
    expect(state.tools).toEqual([decl("x", "new")]);
  });
  it("within one patch removals happen before additions", () => {
    const state = replaySystem([patchEntry("a", { toolsAdded: [decl("x", "old")] }), patchEntry("b", { toolsRemoved: ["x"], toolsAdded: [decl("x", "fresh")] })]);
    expect(state.tools).toEqual([decl("x", "fresh")]);
  });
  it("an empty branch gives an empty state", () => {
    expect(replaySystem([])).toEqual({ sections: {}, tools: [] });
  });
});

describe("diffSystem", () => {
  const base = { sections: { system: "S" }, tools: [decl("a", "da", { type: "object" })] };
  it("nothing differs, nothing to write", () => {
    expect(diffSystem(base, { system: "S", tools: [decl("a", "da", { type: "object" })] })).toBeUndefined();
  });
  it("a different system prompt is written as a section", () => {
    expect(diffSystem(base, { system: "T", tools: base.tools })).toEqual({ sections: { system: "T" } });
  });
  it("a changed description or changed parameters removes the tool and adds it again", () => {
    const byDescription = diffSystem(base, { system: "S", tools: [decl("a", "other", { type: "object" })] });
    expect(byDescription).toEqual({ toolsAdded: [decl("a", "other", { type: "object" })], toolsRemoved: ["a"] });
    const byParameters = diffSystem(base, { system: "S", tools: [decl("a", "da", { type: "string" })] });
    expect(byParameters?.toolsRemoved).toEqual(["a"]);
  });
  it("a changed name is a new tool, and the old one stays declared (no removal)", () => {
    const patch = diffSystem(base, { system: "S", tools: [decl("b", "da", { type: "object" })] });
    expect(patch).toEqual({ toolsAdded: [decl("b", "da", { type: "object" })] });
  });
  it("a tool dropped from the configuration is not removed", () => {
    expect(diffSystem(base, { system: "S", tools: [] })).toBeUndefined();
  });
  it("a prompt that was empty before is written even if the new prompt is empty text", () => {
    expect(diffSystem({ sections: {}, tools: [] }, { system: "", tools: [] })).toEqual({ sections: { system: "" } });
  });
});

describe("renderSystem", () => {
  it("joins the sections with a blank line in the order they were added", () => {
    expect(renderSystem({ sections: { system: "A", extra: "B" }, tools: [] })).toBe("A\n\nB");
    expect(renderSystem({ sections: {}, tools: [] })).toBe("");
  });
});
