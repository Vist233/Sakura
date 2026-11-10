import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Environment, ToolContext } from "@sakura/kernel";
import { createLocalEnvironment } from "@sakura/env";
import { createChatClient } from "@sakura/llm";
import { createMemoryLog } from "@sakura/session";
import { readTool } from "../src/builtin/read.ts";
import { makeBmp } from "./bmp.ts";
import { run, useSandbox } from "./helpers.ts";

const box = useSandbox();
const imagePart = (content: Array<{ type: string }>) => content.find((part) => part.type === "image") as { mediaType: string; ref: string } | undefined;

describe("read: a BMP file", () => {
  it("is converted to a PNG file in the artifacts folder and returned as image/png", async () => {
    await writeFile(join(box.dir, "frame.bmp"), makeBmp({ width: 3, height: 2 }));
    const result = await run(readTool, box.env, { path: "frame.bmp" });
    expect(result.isError).toBeUndefined();
    const image = imagePart(result.content);
    expect(image).toMatchObject({ mediaType: "image/png", ref: join(box.dir, ".sakura/artifacts/read-test.png") });
    const written = await readFile(image!.ref);
    expect([...written.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result.text).toContain("converted from BMP");
    expect(result.text).toContain("frame.bmp");
  });
  it("works under an uppercase extension", async () => {
    await writeFile(join(box.dir, "FRAME.BMP"), makeBmp({ width: 2, height: 2, bits: 32 }));
    expect(imagePart((await run(readTool, box.env, { path: "FRAME.BMP" })).content)?.mediaType).toBe("image/png");
  });
  it("works under a confined environment", async () => {
    const confined = createLocalEnvironment(box.dir, { confine: true });
    await writeFile(join(box.dir, "frame.bmp"), makeBmp({ width: 2, height: 2 }));
    const result = await run(readTool, confined, { path: "frame.bmp" });
    expect(result.isError).toBeUndefined();
    expect((await readFile(imagePart(result.content)!.ref)).length).toBeGreaterThan(8);
  });
  it("works through an environment that only has writeFile, readFile and resolve (remote style)", async () => {
    const files = new Map<string, Uint8Array>([["/remote/frame.bmp", makeBmp({ width: 2, height: 2 })]]);
    const remote = {
      resolve: (path: string) => (path.startsWith("/") ? path : `/remote/${path}`),
      stat: async (path: string) => (files.has(path) ? { isDirectory: false, size: files.get(path)!.length } : undefined),
      readFile: async (path: string) => files.get(path)!,
      writeFile: async (path: string, data: Uint8Array | string) => {
        files.set(remote.resolve(path), typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
    } as unknown as Environment;
    const result = await readTool.execute({ path: "/remote/frame.bmp" }, {
      env: remote,
      signal: new AbortController().signal,
      callId: "call/1",
      log: createMemoryLog(),
      notify: () => undefined,
      watch: () => () => undefined,
    } as ToolContext);
    expect(imagePart(result.content)).toMatchObject({ mediaType: "image/png", ref: "/remote/.sakura/artifacts/read-call_1.png" });
    expect(files.has("/remote/.sakura/artifacts/read-call_1.png")).toBe(true);
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

describe("the converted file reaches the model request", () => {
  it("is read back by the llm layer as a PNG data URL", async () => {
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
      resolveImage: async (ref, mediaType) => `data:${mediaType};base64,${(await readFile(ref)).toString("base64")}`,
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
