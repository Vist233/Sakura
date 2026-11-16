/** Image formats the tools recognise by their first bytes (a file name proves nothing). */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/tiff" | "image/x-icon";

/** The formats that model APIs usually take. What a given model accepts is the model's data; this is only what `read` sends on as an image. */
export const SENDABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean => signature.every((value, index) => bytes[at + index] === value);

/** The format a file really has, read from its first bytes. Undefined when it is not an image we know. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"; // "RIFF....WEBP"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"; // "BM"
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return undefined;
}
