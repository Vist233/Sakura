import { ProviderError } from "@sakura/kernel";
import type { Content, LlmRequest } from "@sakura/kernel";

const IMAGE_REJECTED = /image|vision|multimodal|media.?type/i;

/** The provider refused the request because of an image in it (unsupported format, too large): the same request without those images is worth one more try. */
export const isImageRejection = (error: unknown): boolean => error instanceof ProviderError && error.kind === "invalid_request" && IMAGE_REJECTED.test(error.message);

/** The references of the images in a request. */
export const imageRefs = (request: LlmRequest): string[] => [...new Set(request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "image" ? [part.ref] : []))))];

/** The request with the images of the given references replaced by a sentence for the model, so it knows something was there. */
export function withoutImages(request: LlmRequest, refs: ReadonlySet<string>): LlmRequest {
  if (refs.size === 0) return request;
  const left = (part: Content): boolean => part.type === "image" && refs.has(part.ref);
  const note = (part: Extract<Content, { type: "image" }>): Content => ({ type: "text", text: `[an image could not be sent: the provider rejected it (${part.ref})]` });
  return {
    ...request,
    messages: request.messages.map((message) =>
      message.content.some(left) ? { ...message, content: message.content.map((part) => (part.type === "image" && left(part) ? note(part) : part)) } : message,
    ),
  };
}
