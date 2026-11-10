import { crc32, deflateSync } from "node:zlib";

/** The image formats that model APIs take. Anything else must be converted or refused before it is sent: a refused image is refused for good. */
export const SENDABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof SENDABLE_IMAGE_TYPES)[number] | "image/bmp";

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean => signature.every((value, index) => bytes[at + index] === value);

/** The format a file really has, read from its first bytes (a file name proves nothing). Undefined when it is not an image we know. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"; // "RIFF....WEBP"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"; // "BM"
  return undefined;
}

/** A guard against a header that promises a picture too large to hold in memory. */
const MAX_PIXELS = 50_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * Turns an uncompressed 24-bit or 32-bit BMP (the kind programs write when they dump a frame) into a PNG. Undefined for anything else: a palette,
 * run-length coding, 16 bits, unusual colour masks, a truncated file. The caller then tells the model the file cannot be shown. The alpha byte of a
 * 32-bit BMP is dropped: in this form it is almost always unused (zero) and would make the picture invisible.
 */
export function bmpToPng(bytes: Uint8Array): Uint8Array | undefined {
  if (sniffImageType(bytes) !== "image/bmp" || bytes.length < 54) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  if (headerSize < 40) return undefined; // the old 12-byte header is not handled
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (width <= 0 || height === 0 || width * height > MAX_PIXELS) return undefined;
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) return undefined;
  if (compression === 3) {
    // BI_BITFIELDS: only the usual layout (red 0x00FF0000, green 0x0000FF00, blue 0x000000FF) is understood
    if (bitsPerPixel !== 32 || bytes.length < 66 || view.getUint32(54, true) !== 0x00ff0000 || view.getUint32(58, true) !== 0x0000ff00 || view.getUint32(62, true) !== 0x000000ff) return undefined;
  } else if (compression !== 0) {
    return undefined;
  }

  const bytesPerPixel = bitsPerPixel / 8;
  const rowSize = Math.ceil((width * bitsPerPixel) / 32) * 4;
  if (dataOffset + rowSize * height > bytes.length) return undefined;

  // PNG rows: a filter byte (0 = none) and then red, green, blue for every pixel
  const scanline = 1 + width * 3;
  const raw = Buffer.alloc(scanline * height);
  for (let row = 0; row < height; row++) {
    const source = dataOffset + (topDown ? row : height - 1 - row) * rowSize;
    const target = row * scanline + 1;
    for (let column = 0; column < width; column++) {
      const pixel = source + column * bytesPerPixel;
      raw[target + column * 3] = bytes[pixel + 2] ?? 0;
      raw[target + column * 3 + 1] = bytes[pixel + 1] ?? 0;
      raw[target + column * 3 + 2] = bytes[pixel] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return new Uint8Array(Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]));
}
