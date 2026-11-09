import { describe, expect, it } from "vitest";
import type { Content, LlmRequest } from "@sakura/kernel";
import { createChatClient } from "../src/index.ts";
import { chunk, collect, sse, streamResponse } from "./helpers.ts";

// An image the client cannot turn into a URL (the file is not on this machine, or it was deleted) must not stop the conversation: the model is
// told in words, and the request goes out. Otherwise one bad image makes every later request of the session fail too.
const image = (ref: string): Content => ({ type: "image", mediaType: "image/png", ref });
const requestWith = (content: Content[], role: "user" | "tool" = "user"): LlmRequest => ({
  system: "s",
  messages: [
    { role: "user", content: [{ type: "text", text: "look" }], ts: 1 },
    ...(role === "tool" ? [{ role: "tool" as const, content, ts: 2, toolCallId: "t", toolName: "read" }] : [{ role: "user" as const, content, ts: 2 }]),
  ],
  tools: [],
});

function sent(extra: Record<string, unknown> = {}) {
  const bodies: string[] = [];
  const fake: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    return streamResponse([sse(chunk({ content: "ok" }), chunk({}, "stop"), "[DONE]")]);
  };
  const client = createChatClient({
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    model: "m",
    contextWindow: 1000,
    fetch: fake,
    retry: { sleep: async () => undefined, random: () => 0 },
    ...extra,
  });
  return { client, bodies };
}
const unreadable = async () => {
  throw Object.assign(new Error("ENOENT: no such file or directory, open '/app/pic.png'"), { code: "ENOENT" });
};

describe("an image that cannot be read", () => {
  for (const role of ["user", "tool"] as const) {
    it(`in a ${role} message is replaced by a note and the request still goes out`, async () => {
      const { client, bodies } = sent({ resolveImage: unreadable, compat: { images: true } });
      const events = await collect(client.stream(requestWith([image("/app/pic.png")], role), new AbortController().signal));
      expect(events.some((event) => event.type === "text_delta")).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain("/app/pic.png");
      expect(bodies[0]).toMatch(/could not be read/);
      expect(bodies[0]).not.toContain("image_url");
    });
  }
});

describe("two images in one tool result, one unreadable", () => {
  it("attaches the readable one and names the other", async () => {
    const { client, bodies } = sent({
      compat: { images: true },
      resolveImage: async (ref: string) => {
        if (ref === "/bad.png") throw new Error("ENOENT");
        return "data:image/png;base64,AAAA";
      },
    });
    await collect(client.stream(requestWith([image("/good.png"), image("/bad.png")], "tool"), new AbortController().signal));
    expect(bodies[0]).toContain("data:image/png;base64,AAAA");
    expect(bodies[0]).toContain("could not be read: /bad.png");
    expect(bodies[0]).toContain("see attached image");
  });
});
