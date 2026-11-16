// What the model is told about an image it does not accept: the request is built the same way every time, so the provider is never asked to refuse it.
import { describe, expect, it } from "vitest";
import type { Content, LlmRequest } from "@sakura/kernel";
import { defaultCompat } from "../src/chat/compat.ts";
import type { ChatCompat } from "../src/chat/compat.ts";
import { toWireRequest } from "../src/chat/request.ts";

const image = (ref: string, mediaType: string): Content => ({ type: "image", ref, mediaType });
const history = (...parts: Content[]): LlmRequest => ({
  system: "s",
  tools: [],
  messages: [
    { role: "user", content: [{ type: "text", text: "look" }], ts: 1 },
    { role: "tool", content: [{ type: "text", text: "ok" }, ...parts], ts: 2, toolCallId: "c1" },
  ],
});
const build = (request: LlmRequest, compat: Partial<ChatCompat> = {}, bytes = 10) =>
  toWireRequest(request, { model: "m", compat: { ...defaultCompat, ...compat }, resolveImage: async () => `data:image/png;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}` });
const wireText = async (...args: Parameters<typeof build>) => JSON.stringify(await build(...args));

describe("an image the model accepts", () => {
  it("is sent", async () => {
    expect(await wireText(history(image("/a.png", "image/png")))).toContain('"image_url"');
  });
});

describe("an image the model does not accept", () => {
  it("a format it does not take becomes a note that says what it takes and what to do, and the file is not even read", async () => {
    let read = false;
    const wire = JSON.stringify(
      await toWireRequest(history(image("/frame.bmp", "image/bmp")), {
        model: "m",
        compat: defaultCompat,
        resolveImage: async () => {
          read = true;
          return "data:";
        },
      }),
    );
    expect(wire).toContain("[image /frame.bmp not sent: this model accepts png, jpeg, gif, webp; convert it with a command and read it again]");
    expect(wire).not.toContain('"image_url"');
    expect(read).toBe(false);
  });

  it("the formats are the model's data", async () => {
    const wire = await wireText(history(image("/a.png", "image/png")), { imageFormats: ["image/jpeg"] });
    expect(wire).toContain("not sent: this model accepts jpeg;");
  });

  it("an image over the limit becomes a note that names the limit", async () => {
    const wire = await wireText(history(image("/big.png", "image/png")), { imageMaxBytes: 5_000_000 }, 6_000_000);
    expect(wire).toContain("[image /big.png not sent: this model accepts png, jpeg, gif, webp up to 5 MB; convert it with a command and read it again]");
    expect(wire).not.toContain('"image_url"');
    expect(await wireText(history(image("/ok.png", "image/png")), { imageMaxBytes: 5_000_000 }, 4_000_000)).toContain('"image_url"');
  });

  it("a model without images gets the note it always got", async () => {
    expect(await wireText(history(image("/a.png", "image/png")), { images: false })).toContain("this model cannot read images");
  });

  it("in a user message too", async () => {
    const request: LlmRequest = { system: "s", tools: [], messages: [{ role: "user", content: [image("/x.tiff", "image/tiff")], ts: 1 }] };
    expect(await wireText(request)).toContain("[image /x.tiff not sent:");
  });

  it("only that image is left out; the others in the same history are sent", async () => {
    const wire = await wireText(history(image("/a.bmp", "image/bmp"), image("/b.png", "image/png")));
    expect(wire).toContain("[image /a.bmp not sent");
    expect(wire.match(/"image_url":\{/g)).toHaveLength(1);
  });

  it("the same history always gives the same request", async () => {
    const request = history(image("/a.bmp", "image/bmp"), image("/b.png", "image/png"));
    expect(await wireText(request)).toBe(await wireText(request));
  });
});
