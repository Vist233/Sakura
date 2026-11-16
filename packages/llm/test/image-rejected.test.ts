import { describe, expect, it } from "vitest";
import type { LlmRequest } from "@sakura/kernel";
import { createChatClient } from "../src/index.ts";
import { chunk, collect, sse, streamResponse } from "./helpers.ts";

const withImage: LlmRequest = {
  system: "s",
  tools: [],
  messages: [
    { role: "user", content: [{ type: "text", text: "look" }], ts: 1 },
    {
      role: "tool",
      content: [
        { type: "text", text: "ok" },
        { type: "image", mediaType: "image/bmp", ref: "/tmp/a.bmp" },
      ],
      ts: 2,
      toolCallId: "c1",
    },
  ],
};
const good = () => streamResponse([sse(chunk({ content: "fine" }), chunk({}, "stop"), "[DONE]")]);
const refuse = (message = "unsupported image format") => new Response(JSON.stringify({ error: { message } }), { status: 400 });

function client(fake: typeof fetch) {
  return createChatClient({
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    model: "m",
    contextWindow: 1000,
    fetch: fake,
    compat: { images: true },
    retry: { sleep: async () => undefined, random: () => 0 },
    resolveImage: async () => "data:image/bmp;base64,AA==",
  });
}

describe("a provider that refuses an image", () => {
  it("is asked again once without the image, and the run goes on", async () => {
    const bodies: string[] = [];
    const fake: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? refuse() : good();
    };
    const events = await collect(client(fake).stream(withImage, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "done", stop: "stop" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("image_url");
    expect(bodies[1]).not.toContain("image_url");
    expect(bodies[1]).toContain("could not be sent");
  });

  it("leaves the refused images out of later requests but still sends the others", async () => {
    const bodies: string[] = [];
    const fake: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? refuse() : good();
    };
    const c = client(fake);
    await collect(c.stream(withImage, new AbortController().signal));
    const other: LlmRequest = { ...withImage, messages: [...withImage.messages, { role: "tool", content: [{ type: "image", mediaType: "image/png", ref: "/tmp/b.png" }], ts: 3, toolCallId: "c2" }] };
    await collect(c.stream(other, new AbortController().signal));
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain("/tmp/a.bmp"); // the note names the refused one
    expect(bodies[2]?.match(/"image_url":\{/g)).toHaveLength(1); // the new image is sent
  });

  it("gives up when the request still fails without images", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return refuse();
    };
    await expect(collect(client(fake).stream(withImage, new AbortController().signal))).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toBe(2);
  });

  it("does not touch other bad requests, nor a request that has no image", async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      return refuse("temperature out of range");
    };
    await expect(collect(client(fake).stream(withImage, new AbortController().signal))).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toBe(1);
    calls = 0;
    const plain: LlmRequest = { ...withImage, messages: [withImage.messages[0]!] };
    const fake2: typeof fetch = async () => {
      calls++;
      return refuse();
    };
    await expect(collect(client(fake2).stream(plain, new AbortController().signal))).rejects.toMatchObject({ kind: "invalid_request" });
    expect(calls).toBe(1);
  });
});
