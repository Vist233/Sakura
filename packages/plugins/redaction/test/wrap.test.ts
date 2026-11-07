import { describe, expect, it } from "vitest";
import type { LlmRequest } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { redactionPlugin } from "../src/index.ts";

import { githubToken } from "./fixtures.ts";

const SECRET = githubToken(1);
const request = (text: string, system = "system"): LlmRequest => ({ system, messages: [{ role: "user", content: [{ type: "text", text }], ts: 0 }], tools: [] });
const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _event of stream) void _event;
};

describe("redactionPlugin.wrap", () => {
  it("masks secrets in the messages and the system prompt of every request", async () => {
    const inner = createFauxClient([{ text: "ok" }, { text: "ok" }]);
    const wrapped = redactionPlugin({ key: "w" }).wrap(inner);
    await drain(wrapped.stream(request(`token ${SECRET}`, `rules ${SECRET}`), new AbortController().signal));
    await drain(wrapped.stream(request("nothing here"), new AbortController().signal));
    expect(inner.requests).toHaveLength(2);
    expect(JSON.stringify(inner.requests)).not.toContain(SECRET);
    expect(inner.requests[0]!.messages[0]!.content[0]).toMatchObject({ text: expect.stringContaining("{{") });
  });

  it("keeps the model information of the client it wraps", () => {
    const inner = createFauxClient([]);
    expect(redactionPlugin().wrap(inner).model).toBe(inner.model);
  });

  it("uses the same placeholder as the plugin's own requests (the same key and the same secret)", async () => {
    const inner = createFauxClient([{ text: "ok" }]);
    const plugin = redactionPlugin({ key: "same" });
    await drain(plugin.wrap(inner).stream(request(SECRET), new AbortController().signal));
    const sent = (inner.requests[0]!.messages[0]!.content[0] as { text: string }).text;
    expect(plugin.restore(sent)).toBe(SECRET);
    expect(plugin.scrub(SECRET)).toBe(sent);
  });

  it("passes the abort signal on and does not touch the answer", async () => {
    const inner = createFauxClient([{ text: "the answer" }]);
    const controller = new AbortController();
    const events: unknown[] = [];
    for await (const event of redactionPlugin().wrap(inner).stream(request("hi"), controller.signal)) events.push(event);
    expect(events).toContainEqual({ type: "text_delta", delta: "the answer" });
  });
});

describe("what the redaction plugin looks at in a request", () => {
  const plugin = () => redactionPlugin({ key: "deep" });
  const askWith = async (content: unknown[]) => {
    const inner = createFauxClient([{ text: "ok" }]);
    await drain(
      plugin()
        .wrap(inner)
        .stream({ system: "s", messages: [{ role: "assistant", content: content as never, ts: 0 }], tools: [] }, new AbortController().signal),
    );
    return inner.requests[0]!.messages[0]!.content;
  };

  it("secrets inside the arguments of an earlier tool call are masked, at any depth", async () => {
    const [part] = (await askWith([{ type: "tool_call", id: "c", name: "bash", args: { command: `echo ${SECRET}`, nested: { list: [SECRET, 5, true, null] } } }])) as Array<{ args: any }>;
    expect(JSON.stringify(part)).not.toContain(SECRET);
    expect(part!.args.nested.list.slice(1)).toEqual([5, true, null]); // other values are left as they were
  });

  it("vendor data kept for replay is masked too, and images are left alone", async () => {
    const parts = (await askWith([
      { type: "provider", vendor: "x", data: { reasoning: `my token is ${SECRET}` } },
      { type: "image", mediaType: "image/png", ref: "r" },
    ])) as Array<{ type: string }>;
    expect(JSON.stringify(parts[0])).not.toContain(SECRET);
    expect(parts[1]).toEqual({ type: "image", mediaType: "image/png", ref: "r" });
  });

  it("a very long conversation does not make it forget how to mask", async () => {
    const instance = plugin();
    for (let index = 0; index < 5100; index++) instance.scrub(`unique text number ${index} with enough length`);
    expect(instance.scrub(`token ${SECRET}`)).not.toContain(SECRET);
  });
});

describe("rules written by the user", () => {
  it("work without the d and g flags, and with keywords in capitals", () => {
    const own = redactionPlugin({ key: "own", rules: [{ id: "acme-token", regex: /ACME-[a-z0-9]{12}/, secretGroup: 0, entropy: 0, keywords: ["ACME-"] }] });
    expect(own.scrub("the token is ACME-7f3k9d2m1x8q and more")).not.toContain("ACME-7f3k9d2m1x8q");
    expect(own.scrub("ACME-7f3k9d2m1x8q ACME-aaaaaaaaaaaa")).not.toMatch(/ACME-[a-z0-9]{12}/); // every match, not just the first
  });

  it("a secret of fewer than six characters, or one made of a single repeated character, is left alone", () => {
    const own = redactionPlugin({ key: "own", rules: [{ id: "short", regex: /KEY=(\w+)/, secretGroup: 1, entropy: 0, keywords: ["key="] }] });
    expect(own.scrub("see KEY=ab here and KEY=aaaaaaaaa there")).toBe("see KEY=ab here and KEY=aaaaaaaaa there");
  });

  it("text that is already a placeholder is not masked again", () => {
    const own = redactionPlugin({ key: "own", rules: [{ id: "any", regex: /\{\{[A-Z_]+_[0-9a-f]{8}\}\}/, secretGroup: 0, entropy: 0, keywords: ["{{"] }] });
    const text = "a placeholder {{TOKEN_0123abcd}} stays";
    expect(own.scrub(text)).toBe(text);
  });

  it("a rule that needs some entropy skips a dull string", () => {
    const own = redactionPlugin({ key: "own", rules: [{ id: "tok", regex: /tok_[a-z]{10}/, secretGroup: 0, entropy: 3.5, keywords: ["tok_"] }] });
    expect(own.scrub("tok_aaaaabbbbb tok_qwxzvkmpdj")).toBe(`tok_aaaaabbbbb ${own.scrub("tok_qwxzvkmpdj")}`);
    expect(own.scrub("tok_qwxzvkmpdj")).not.toContain("tok_qwxzvkmpdj");
  });
});
