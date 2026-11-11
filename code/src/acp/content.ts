// ACP prompt blocks to what the framework agent receives: one text and a list of images. Pure; saving the images is `attachments.ts`.
import type { PromptBlock } from "./types.ts";

/** An image sent with the prompt, as base64 (the agent writes it to a file, because the framework reads images by path). */
export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface PromptContent {
  text: string;
  images: PromptImage[];
}

/** Longest embedded text resource kept (characters) and largest image taken (base64 characters, about 10 MB of picture). */
export const MAX_RESOURCE_TEXT = 100_000;
export const MAX_IMAGE_BASE64 = 14_000_000;
export const MAX_IMAGES = 10;

function fileLinkPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function embedded(block: PromptBlock): string {
  const resource = record((block as Record<string, unknown>).resource);
  const uri = typeof resource.uri === "string" ? resource.uri : "a resource";
  if (typeof resource.text === "string") {
    const body = resource.text.length > MAX_RESOURCE_TEXT ? `${resource.text.slice(0, MAX_RESOURCE_TEXT)}\n… (${resource.text.length - MAX_RESOURCE_TEXT} more characters not shown)` : resource.text;
    return `Contents of ${uri}:\n\`\`\`\n${body}\n\`\`\``;
  }
  return `[${uri} was sent as binary data, which the agent does not read]`;
}

/**
 * Text blocks are joined with a blank line. A link to a file becomes an `@path` mention, which the agent reads like one typed in the
 * terminal; any other link stays a Markdown link. An embedded text resource is quoted with its address. Images are returned apart.
 * What cannot be used (audio, binary resources, too many or too large images, unknown blocks) leaves a one-line note, so the model knows
 * something was there. An empty text and no images mean there is nothing to run.
 */
export function promptContent(blocks: readonly PromptBlock[]): PromptContent {
  const parts: string[] = [];
  const images: PromptImage[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource_link" && typeof block.uri === "string") {
      const path = fileLinkPath(block.uri);
      parts.push(path ? `@${path}` : `[${typeof block.name === "string" ? block.name : block.uri}](${block.uri})`);
    } else if (block.type === "resource") parts.push(embedded(block));
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      if (block.data.length > MAX_IMAGE_BASE64) parts.push("[an image was sent but is too large]");
      else if (images.length >= MAX_IMAGES) parts.push(`[more than ${MAX_IMAGES} images were sent; the rest were left out]`);
      else images.push({ data: block.data, mimeType: block.mimeType });
    } else parts.push(`[an attachment of type ${String(block.type)} was sent but is not supported]`);
  }
  return { text: parts.join("\n\n").trim(), images };
}
