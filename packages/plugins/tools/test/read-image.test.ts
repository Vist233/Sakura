import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTool } from "../src/builtin/read.ts";
import { run, useSandbox } from "./helpers.ts";

const box = useSandbox();
const imagePart = (content: Array<{ type: string }>) => content.find((part) => part.type === "image") as { mediaType: string; ref: string } | undefined;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const BMP = Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0]);

describe("read: an image file", () => {
  it("of a format the models take is returned as an image with the type its bytes say, not the one its name says", async () => {
    await writeFile(join(box.dir, "shot.jpg"), PNG); // named jpg, really png
    const result = await run(readTool, box.env, { path: "shot.jpg" });
    expect(result.isError).toBeUndefined();
    expect(imagePart(result.content)).toMatchObject({ mediaType: "image/png", ref: join(box.dir, "shot.jpg") });
  });

  it("of another format (bmp, tiff, ico) is an error that says what it is and how to convert it, and carries no image", async () => {
    await writeFile(join(box.dir, "frame.bmp"), BMP);
    const result = await run(readTool, box.env, { path: "frame.bmp" });
    expect(result.isError).toBe(true);
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(result.text).toContain("frame.bmp is image/bmp; the model accepts png, jpeg, gif, webp");
    expect(result.text).toContain("magick frame.bmp out.png");
    await writeFile(join(box.dir, "scan.tif"), Uint8Array.from([0x49, 0x49, 0x2a, 0x00]));
    expect((await run(readTool, box.env, { path: "scan.tif" })).text).toContain("is image/tiff");
  });

  it("works under an uppercase extension", async () => {
    await writeFile(join(box.dir, "FRAME.BMP"), BMP);
    expect((await run(readTool, box.env, { path: "FRAME.BMP" })).text).toContain("is image/bmp");
  });

  it("whose name says picture but whose bytes are text is shown as text", async () => {
    await writeFile(join(box.dir, "fake.bmp"), "just words\n");
    expect((await run(readTool, box.env, { path: "fake.bmp" })).text).toBe("just words");
  });

  it("the description lists the formats", () => {
    expect(readTool.description).toContain("png, jpeg, gif and webp");
  });
});
