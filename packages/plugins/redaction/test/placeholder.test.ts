import { describe, expect, it } from "vitest";
import { PLACEHOLDER } from "../src/engine.ts";

describe("PLACEHOLDER pattern", () => {
  const matches = (text: string) => text.match(PLACEHOLDER) ?? [];
  it("matches {{NAME_8hex}} and finds several in one text", () => {
    expect(matches("a {{GITHUB_TOKEN_0123abcd}} b {{AWS_KEY_ffffffff}}")).toEqual(["{{GITHUB_TOKEN_0123abcd}}", "{{AWS_KEY_ffffffff}}"]);
  });
  for (const text of ["{{github_token_0123abcd}}", "{{TOKEN_0123abc}}", "{{TOKEN_0123abcde}}", "{TOKEN_0123abcd}", "{{TOKEN0123abcd}}", "{{TOKEN_0123ABCD}}"]) {
    it(`does not match ${text}`, () => expect(matches(text)).toEqual([]));
  }
});
