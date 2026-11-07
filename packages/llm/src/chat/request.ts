import type { Content, LlmRequest, Message } from "@sakura/kernel";
import { thinkingParameters } from "./compat.ts";
import type { ChatCompat } from "./compat.ts";

type Wire = Record<string, unknown>;
export type ResolveImage = (ref: string, mediaType: string) => Promise<string>;

export interface WireContext {
  model: string;
  compat: ChatCompat;
  resolveImage: ResolveImage;
}

const textOf = (content: Content[]): string => content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

async function userParts(content: Content[], context: WireContext): Promise<string | Wire[]> {
  const parts: Wire[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      if (context.compat.images) {
        parts.push({ type: "image_url", image_url: { url: await context.resolveImage(part.ref, part.mediaType) } });
      } else {
        parts.push({ type: "text", text: "[an image was attached but this model cannot read images]" });
      }
    }
  }
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text as string;
  return parts;
}

function assistantMessage(message: Message, compat: ChatCompat): Wire {
  const wire: Wire = { role: "assistant", content: textOf(message.content) };
  const calls = message.content.flatMap((part) =>
    part.type === "tool_call" ? [{ id: part.id, type: "function", function: { name: part.name, arguments: typeof part.args === "string" ? part.args : JSON.stringify(part.args ?? {}) } }] : [],
  );
  if (calls.length > 0) wire.tool_calls = calls;
  if (compat.replayReasoning) {
    const reasoning = message.content.flatMap((part) => (part.type === "provider" && part.vendor === compat.vendor ? [String((part.data as { reasoning?: string }).reasoning ?? "")] : []));
    wire.reasoning_content = reasoning.join("");
  }
  return wire;
}

/** Turns the internal request into a Chat Completions request body. */
export async function toWireRequest(request: LlmRequest, context: WireContext): Promise<Wire> {
  const { compat } = context;
  const messages: Wire[] = [];
  if (request.system) messages.push({ role: "system", content: request.system });

  let pendingImages: Wire[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    messages.push({ role: "user", content: [{ type: "text", text: "Images from the tool results above:" }, ...pendingImages] });
    pendingImages = [];
  };

  for (const message of request.messages) {
    if (message.role !== "tool") flushImages();
    if (message.role === "user") {
      messages.push({ role: "user", content: await userParts(message.content, context) });
    } else if (message.role === "system") {
      messages.push({ role: "system", content: textOf(message.content) });
    } else if (message.role === "assistant") {
      messages.push(assistantMessage(message, compat));
    } else {
      // Tool messages carry text only; images move to a user message after the last tool result.
      const images = message.content.filter((part) => part.type === "image");
      let content = textOf(message.content);
      if (images.length > 0) {
        if (compat.images) {
          for (const image of images) {
            if (image.type === "image") {
              pendingImages.push({ type: "image_url", image_url: { url: await context.resolveImage(image.ref, image.mediaType) } });
            }
          }
          content = content ? `${content}\n(see attached image)` : "(see attached image)";
        } else {
          content = content ? `${content}\n[an image was returned but this model cannot read images]` : "[an image was returned but this model cannot read images]";
        }
      }
      const wire: Wire = { role: "tool", tool_call_id: message.toolCallId ?? "", content };
      if (compat.toolResultName && message.toolName) wire.name = message.toolName;
      messages.push(wire);
    }
  }
  flushImages();

  const body: Wire = { model: context.model, messages, stream: true };
  if (compat.streamUsage) body.stream_options = { include_usage: true };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  }
  if (request.maxTokens !== undefined) body[compat.maxTokensField] = request.maxTokens;
  Object.assign(body, thinkingParameters(compat, request.thinking));
  return body;
}
