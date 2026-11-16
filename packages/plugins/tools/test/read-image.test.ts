import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalEnvironment } from "@sakura/env";
import { createChatClient } from "@sakura/llm";
import { readTool } from "../src/builtin/read.ts";
import { makeBmp } from "./bmp.ts";
import { run, useSandbox } from "./helpers.ts";

const box = useSandbox();
const imagePart = (content: Array<{ type: string }>) => content.find((part) => part.type === "image") as { mediaType: string; ref: string } | undefined;

describe("read: a BMP file", () => {
  it("is returned as the BMP it is, with the original path: the conversion to PNG happens when the request is built", async () => {
    await writeFile(join(box.dir, "frame.bmp"), makeBmp({ width: 3, height: 2 }));
    const result = await run(readTool, box.env, { path: "frame.bmp" });
    expect(result.isError).toBeUndefined();
    expect(imagePart(result.content)).toMatchObject({ mediaType: "image/bmp", ref: join(box.dir, "frame.bmp") });
    expect(result.text).toContain("sent to the model as PNG");
  });
  it("works under an uppercase extension", async () => {
    await writeFile(join(box.dir, "FRAME.BMP"), makeBmp({ width: 2, height: 2, bits: 32 }));
    expect(imagePart((await run(readTool, box.env, { path: "FRAME.BMP" })).content)?.mediaType).toBe("image/bmp");
  });
  it("works under a confined environment", async () => {
    const confined = createLocalEnvironment(box.dir, { confine: true });
    await writeFile(join(box.dir, "frame.bmp"), makeBmp({ width: 2, height: 2 }));
    const result = await run(readTool, confined, { path: "frame.bmp" });
    expect(result.isError).toBeUndefined();
    expect(imagePart(result.content)?.ref).toBe(join(box.dir, "frame.bmp"));
  });
  it("that cannot be converted is an error with a command to use instead", async () => {
    const palette = Buffer.from(makeBmp({ width: 2, height: 2 }));
    palette.writeUInt16LE(8, 28);
    await writeFile(join(box.dir, "pal.bmp"), palette);
    const result = await run(readTool, box.env, { path: "pal.bmp" });
    expect(result.isError).toBe(true);
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(result.text).toContain("magick pal.bmp");
  });
  it("that is really text is shown as text", async () => {
    await writeFile(join(box.dir, "fake.bmp"), "just words\n");
    expect((await run(readTool, box.env, { path: "fake.bmp" })).text).toBe("just words");
  });
});

describe("the BMP reaches the model request as a PNG", () => {
  it("the llm layer converts it when it reads the file", async () => {
    await writeFile(join(box.dir, "frame.bmp"), makeBmp({ width: 2, height: 2 }));
    const result = await run(readTool, box.env, { path: "frame.bmp" });
    const image = imagePart(result.content)!;
    const bodies: string[] = [];
    const client = createChatClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      contextWindow: 1000,
      compat: { images: true },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    const events = client.stream(
      {
        system: "s",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", mediaType: image.mediaType, ref: image.ref },
            ],
            ts: 1,
          },
        ],
        tools: [],
      },
      new AbortController().signal,
    );
    for await (const _ of events) void _;
    expect(bodies[0]).toContain("data:image/png;base64,iVBORw0KGgo");
    expect(bodies[0]).not.toContain("image/bmp");
  });
});
