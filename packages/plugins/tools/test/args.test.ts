import { describe, expect, it } from "vitest";
import { ArgumentError, arrayOf, optionalInteger, optionalNumber, rawRecord, requireString } from "../src/builtin/args.ts";
import { DEFAULT_FOLD } from "../src/fold.ts";

describe("rawRecord", () => {
  it("accepts a plain object", () => expect(rawRecord({ a: 1 })).toEqual({ a: 1 }));
  for (const bad of [null, undefined, "text", 5, [1, 2]]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(() => rawRecord(bad)).toThrow(ArgumentError));
  }
});

describe("requireString", () => {
  it("returns a string, including the empty string", () => {
    expect(requireString({ path: "a" }, "path")).toBe("a");
    expect(requireString({ path: "" }, "path")).toBe("");
  });
  for (const bad of [{}, { path: 1 }, { path: null }, { path: ["a"] }]) {
    it(`rejects ${JSON.stringify(bad)} and names the argument`, () => expect(() => requireString(bad, "path")).toThrow("'path' must be a string."));
  }
});

describe("optionalInteger", () => {
  it("missing or null is undefined", () => {
    expect(optionalInteger({}, "n", 1)).toBeUndefined();
    expect(optionalInteger({ n: null }, "n", 1)).toBeUndefined();
  });
  it("accepts integers at or above the minimum", () => {
    expect(optionalInteger({ n: 1 }, "n", 1)).toBe(1);
    expect(optionalInteger({ n: 50 }, "n", 1)).toBe(50);
    expect(optionalInteger({ n: 0 }, "n", 0)).toBe(0);
  });
  for (const bad of [0, -3, 1.5, "2", NaN, Infinity]) {
    it(`rejects ${String(bad)} with a message that says the minimum`, () => expect(() => optionalInteger({ n: bad }, "n", 1)).toThrow("'n' must be an integer of at least 1."));
  }
});

describe("optionalNumber", () => {
  it("missing or null is undefined", () => {
    expect(optionalNumber({}, "t", 0)).toBeUndefined();
    expect(optionalNumber({ t: null }, "t", 0)).toBeUndefined();
  });
  it("accepts numbers above the bound, fractions included", () => {
    expect(optionalNumber({ t: 0.5 }, "t", 0)).toBe(0.5);
    expect(optionalNumber({ t: 120 }, "t", 0)).toBe(120);
  });
  for (const bad of [0, -1, "5", NaN]) {
    it(`rejects ${String(bad)}`, () => expect(() => optionalNumber({ t: bad }, "t", 0)).toThrow("'t' must be a number greater than 0."));
  }
});

describe("arrayOf", () => {
  it("returns the array", () => expect(arrayOf({ items: [1, 2] }, "items")).toEqual([1, 2]));
  for (const bad of [{}, { items: "x" }, { items: {} }, { items: null }]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(() => arrayOf(bad, "items")).toThrow("'items' must be an array."));
  }
});

describe("DEFAULT_FOLD", () => {
  it("is 2000 lines or 50 KB, whichever comes first", () => {
    expect(DEFAULT_FOLD).toEqual({ maxLines: 2000, maxBytes: 50 * 1024 });
  });
});
