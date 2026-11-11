// Images that come with a prompt are written to files next to the session, because the framework reads an image by its path.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Content } from "../framework.ts";
import type { PromptImage } from "./content.ts";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };

/** The framework content for the images: a file per picture, named after its hash (the same picture twice is one file). A type the models do not read becomes a text note. */
export async function saveImages(directory: string, images: readonly PromptImage[]): Promise<Content[]> {
  const content: Content[] = [];
  for (const image of images) {
    const extension = EXTENSIONS[image.mimeType.toLowerCase()];
    const bytes = Buffer.from(image.data, "base64");
    if (!extension || bytes.length === 0) {
      content.push({ type: "text", text: `[an image of type ${image.mimeType} was sent but cannot be read]` });
      continue;
    }
    const path = join(directory, `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${extension}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
    content.push({ type: "image", mediaType: image.mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : image.mimeType.toLowerCase(), ref: path });
  }
  return content;
}
