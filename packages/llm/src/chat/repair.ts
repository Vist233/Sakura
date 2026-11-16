import { ProviderError } from "@sakura/kernel";
import type { Content, LlmRequest } from "@sakura/kernel";

const IMAGE_REJECTED = /image|vision|multimodal|media.?type/i;

/** The provider refused the request because of an image in it (unsupported format, too large): the same request without the images is worth one more try. */
export const isImageRejection = (error: unknown): boolean => error instanceof ProviderError && error.kind === "invalid_request" && IMAGE_REJECTED.test(error.message);

const hasImage = (content: Content[]): boolean => content.some((part) => part.type === "image");

export const hasImages = (request: LlmRequest): boolean => request.messages.some((message) => hasImage(message.content));

/** The request with every image replaced by a sentence for the model, so it knows something was there. */
export function withoutImages(request: LlmRequest): LlmRequest {
  const note = (part: Extract<Content, { type: "image" }>): Content => ({ type: "text", text: `[an image could not be sent: the provider rejected it (${part.ref})]` });
  return {
    ...request,
    messages: request.messages.map((message) => (hasImage(message.content) ? { ...message, content: message.content.map((part) => (part.type === "image" ? note(part) : part)) } : message)),
  };
}
