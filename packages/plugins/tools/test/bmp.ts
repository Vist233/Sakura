/** BMP files built by hand, for tests. */
export interface BmpOptions {
  width: number;
  height: number;
  bits?: 24 | 32;
  topDown?: boolean;
  compression?: number;
  headerSize?: number;
  /** blue, green, red[, alpha] of each pixel, row by row from the top of the picture */
  pixel?: (x: number, y: number) => number[];
  masks?: [number, number, number];
}

/** A BMP file built by hand. */
export function makeBmp(options: BmpOptions): Uint8Array {
  const { width, height, bits = 24, topDown = false, compression = 0, headerSize = 40, masks } = options;
  const pixel = options.pixel ?? ((x, y) => [x * 10, y * 10, x + y, 0]);
  const rowSize = Math.ceil((width * bits) / 32) * 4;
  const maskBytes = compression === 3 ? 12 : 0;
  const dataOffset = 14 + headerSize + maskBytes;
  const bytes = Buffer.alloc(dataOffset + rowSize * height);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(dataOffset, 10);
  bytes.writeUInt32LE(headerSize, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(topDown ? -height : height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(bits, 28);
  bytes.writeUInt32LE(compression, 30);
  if (compression === 3) {
    const [red, green, blue] = masks ?? [0x00ff0000, 0x0000ff00, 0x000000ff];
    bytes.writeUInt32LE(red, 54);
    bytes.writeUInt32LE(green, 58);
    bytes.writeUInt32LE(blue, 62);
  }
  for (let y = 0; y < height; y++) {
    const fileRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const values = pixel(x, y);
      for (let channel = 0; channel < bits / 8; channel++) bytes[dataOffset + fileRow * rowSize + x * (bits / 8) + channel] = values[channel] ?? 0;
    }
  }
  return bytes;
}
