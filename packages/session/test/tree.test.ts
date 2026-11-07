import { describe, expect, it } from "vitest";
import type { LogEntry } from "@sakura/kernel";
import { createTree } from "../src/tree.ts";

const entry = (id: string, parentId: string | null): LogEntry => ({ id, parentId, ts: 1, type: "custom", customType: "n", data: id });
const ids = (list: readonly LogEntry[]) => list.map((item) => item.id);

describe("createTree", () => {
  it("starts empty with no leaf", () => {
    const tree = createTree([]);
    expect(tree.leaf()).toBeNull();
    expect(tree.branch()).toEqual([]);
  });
  it("loaded entries make the last one the leaf and the branch follows the parents", () => {
    const tree = createTree([entry("a", null), entry("b", "a"), entry("c", "b")]);
    expect(tree.leaf()).toBe("c");
    expect(ids(tree.branch())).toEqual(["a", "b", "c"]);
  });
  it("add moves the leaf to the new entry", () => {
    const tree = createTree([entry("a", null)]);
    tree.add(entry("b", "a"));
    expect(tree.leaf()).toBe("b");
    expect(ids(tree.branch())).toEqual(["a", "b"]);
  });
  it("moving the leaf back and adding makes a new branch; the old one is not on the current path", () => {
    const tree = createTree([entry("a", null), entry("b", "a"), entry("c", "b")]);
    tree.moveLeaf("a");
    tree.add(entry("d", "a"));
    expect(ids(tree.branch())).toEqual(["a", "d"]);
    tree.moveLeaf("c");
    expect(ids(tree.branch())).toEqual(["a", "b", "c"]);
  });
  it("moveLeaf(null) clears the branch; an unknown id throws and keeps the leaf", () => {
    const tree = createTree([entry("a", null)]);
    expect(() => tree.moveLeaf("zzz")).toThrow("no entry with id zzz");
    expect(tree.leaf()).toBe("a");
    tree.moveLeaf(null);
    expect(tree.branch()).toEqual([]);
  });
  it("a broken chain (parent missing) stops at the break instead of looping", () => {
    const tree = createTree([entry("b", "gone"), entry("c", "b")]);
    expect(ids(tree.branch())).toEqual(["b", "c"]);
  });
});
