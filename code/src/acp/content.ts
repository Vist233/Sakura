// ACP prompt blocks to the text the framework agent receives.
import type { PromptBlock } from "./types.ts";

function fileLinkPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

/**
 * Text blocks are joined with a blank line. A link to a file becomes an `@path` mention, which the agent reads like one typed
 * in the terminal; any other link stays a Markdown link. Blocks the agent does not read yet (images, audio, embedded
 * resources) leave a one-line note so the model knows something was there. An empty result means there is nothing to run.
 */
export function promptText(blocks: readonly PromptBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource_link" && typeof block.uri === "string") {
      const path = fileLinkPath(block.uri);
      parts.push(path ? `@${path}` : `[${typeof block.name === "string" ? block.name : block.uri}](${block.uri})`);
    } else parts.push(`[a ${String(block.type)} attachment was sent but is not supported yet]`);
  }
  return parts.join("\n\n").trim();
}
