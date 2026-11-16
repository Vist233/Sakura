// The bounded output of a command: one rule for every collector.
import { describe, expect, it } from "vitest";
import { appendTail, lastChars } from "../src/tail.ts";

describe("appendTail", () => {
  it("keeps everything below the limit", () => {
    expect(appendTail("ab", "cd", 10)).toBe("abcd");
  });
  it("cuts back to the last part once the text is well past the limit, so it never grows without end", () => {
    let text = "";
    for (let index = 0; index < 1000; index++) text = appendTail(text, `${index % 10}`, 10);
    expect(text.length).toBeLessThanOrEqual(20);
    expect(lastChars(text, 10)).toBe("0123456789");
  });
});
