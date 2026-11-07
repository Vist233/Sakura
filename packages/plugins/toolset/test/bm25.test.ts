import { describe, expect, it } from "vitest";
import { rank, tokenize } from "../src/bm25.ts";

describe("tokenize", () => {
  const cases: Array<[string, string[]]> = [
    ["fooBar_baz-qux", ["foo", "bar", "baz", "qux"]],
    ["Read File", ["read", "file"]],
    ["mcp__github__create_issue", ["mcp", "github", "create", "issue"]],
    ["  ", []],
    ["HTTP2 server", ["http2", "server"]],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => expect(tokenize(input)).toEqual(expected));
  }
});

describe("rank", () => {
  const docs = ["create a github issue", "list files in a directory", "send an email message", "search the web for pages", "create a calendar event"];
  it("puts the matching document first", () => {
    expect(rank(docs, "github issue")[0]?.index).toBe(0);
    expect(rank(docs, "email")[0]?.index).toBe(2);
    expect(rank(docs, "files directory")[0]?.index).toBe(1);
  });
  it("leaves out documents with no matching word", () => {
    expect(rank(docs, "zebra")).toEqual([]);
    expect(rank(docs, "email").map((item) => item.index)).toEqual([2]);
  });
  it("a rarer word weighs more than a common one", () => {
    const result = rank(["create item", "create issue", "create event", "create note"], "create issue");
    expect(result[0]?.index).toBe(1);
  });
  it("ties keep the original order", () => {
    expect(rank(["alpha beta", "alpha beta", "alpha beta"], "alpha").map((item) => item.index)).toEqual([0, 1, 2]);
  });
  it("an empty query or empty list gives nothing", () => {
    expect(rank(docs, "")).toEqual([]);
    expect(rank([], "x")).toEqual([]);
  });
  it("repeating a word in the document raises the score, with diminishing return", () => {
    const [one, two, four] = [rank(["cat"], "cat")[0]!.score, rank(["cat cat"], "cat")[0]!.score, rank(["cat cat cat cat"], "cat")[0]!.score];
    expect(two).toBeGreaterThan(one);
    expect(four - two).toBeLessThan(two - one + 1);
  });
  it("is case-insensitive", () => {
    expect(rank(["Create Issue"], "CREATE issue")).toHaveLength(1);
  });
});

describe("rank: the scores themselves (BM25 with k1 = 1.2, b = 0.75; expected values worked out by hand)", () => {
  const close = (actual: number | undefined, expected: number) => expect(actual).toBeCloseTo(expected, 10);

  it("a shorter document and a repeated word both count, against the average length", () => {
    const result = rank(["alpha beta", "gamma", "alpha alpha delta epsilon"], "alpha");
    expect(result.map((item) => item.index)).toEqual([2, 0]);
    close(result[0]?.score, 0.5381454193594297);
    close(result[1]?.score, 0.4991762683023676);
  });

  it("scores of several query words add up; equal scores keep the original order", () => {
    const result = rank(["alpha beta", "gamma delta", "zeta"], "alpha delta");
    expect(result.map((item) => item.index)).toEqual([0, 1]);
    close(result[0]?.score, 0.9066488893385706);
    close(result[1]?.score, 0.9066488893385706);
  });

  it("a word repeated in the query counts once", () => {
    expect(rank(["alpha beta", "gamma", "alpha alpha delta epsilon"], "alpha alpha alpha")).toEqual(rank(["alpha beta", "gamma", "alpha alpha delta epsilon"], "alpha"));
  });

  it("the document length is compared with the average of all documents", () => {
    const result = rank(["a b c d", "a"], "a b");
    close(result[0]?.score, 0.702931102984883);
    close(result[1]?.score, 0.24163097888355428);
  });

  it("no documents, or a query with no words, gives nothing", () => {
    expect(rank([], "a")).toEqual([]);
    expect(rank(["a b"], "")).toEqual([]);
    expect(rank(["a b"], "---")).toEqual([]);
  });
});
