import { describe, expect, it } from "vitest";
import { createRng } from "../src/rng.ts";

describe("createRng", () => {
  it("the same seed gives the same sequence; a different seed gives another", () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const first = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(first);
  });
  it("next stays in [0, 1)", () => {
    const rng = createRng(1);
    for (let index = 0; index < 1000; index++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
  it("int covers the whole inclusive range and never leaves it", () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    for (let index = 0; index < 500; index++) seen.add(rng.int(2, 6));
    expect([...seen].sort()).toEqual([2, 3, 4, 5, 6]);
  });
  it("pick returns members of the list", () => {
    const rng = createRng(4);
    const items = ["x", "y", "z"];
    for (let index = 0; index < 50; index++) expect(items).toContain(rng.pick(items));
  });
  it("chance(0) is never and chance(1) is always", () => {
    const rng = createRng(5);
    for (let index = 0; index < 100; index++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });
});
