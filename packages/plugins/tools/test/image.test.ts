import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bmpToPng, sniffImageType } from "../src/builtin/image.ts";
import { type BmpOptions, makeBmp } from "./bmp.ts";

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** red, green, blue of the pixel at (x, y) */
  rgb: (x: number, y: number) => number[];
}

/** Reads a PNG back by the book: signature, every chunk's CRC, IHDR, the inflated rows. Throws when anything is wrong. */
function decodePng(png: Uint8Array): DecodedPng {
  const buffer = Buffer.from(png);
  expect([...buffer.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  const chunks: Array<{ type: string; data: Buffer }> = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    expect(buffer.readUInt32BE(offset + 8 + length)).toBe(crc32(buffer.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  const header = chunks[0]!.data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = inflateSync(chunks[1]!.data);
  const scanline = 1 + width * 3;
  expect(raw.length).toBe(scanline * height);
  return {
    width,
    height,
    bitDepth: header[8]!,
    colorType: header[9]!,
    rgb: (x, y) => {
      expect(raw[y * scanline]).toBe(0);
      const at = y * scanline + 1 + x * 3;
      return [raw[at]!, raw[at + 1]!, raw[at + 2]!];
    },
  };
}

describe("sniffImageType", () => {
  const cases: Array<[string, number[], string]> = [
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0], "image/png"],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0], "image/jpeg"],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    ["webp", [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    ["bmp", [0x42, 0x4d, 0, 0], "image/bmp"],
  ];
  for (const [name, bytes, type] of cases) {
    it(`recognises ${name}`, () => expect(sniffImageType(Uint8Array.from(bytes))).toBe(type));
  }
  it("returns undefined for junk, text, empty input and a RIFF file that is not webp", () => {
    expect(sniffImageType(new TextEncoder().encode("hello world"))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
    expect(sniffImageType(Uint8Array.from([0x89, 0x50]))).toBeUndefined();
    expect(sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
  });
});

describe("bmpToPng", () => {
  const shapes: Array<[string, BmpOptions]> = [
    ["24-bit bottom-up, width 1 (3 padding bytes)", { width: 1, height: 3 }],
    ["24-bit bottom-up, width 2 (2 padding bytes)", { width: 2, height: 3 }],
    ["24-bit bottom-up, width 3 (1 padding byte)", { width: 3, height: 2 }],
    ["24-bit bottom-up, width 4 (no padding)", { width: 4, height: 2 }],
    ["24-bit top-down", { width: 3, height: 4, topDown: true }],
    ["32-bit bottom-up", { width: 5, height: 3, bits: 32 }],
    ["32-bit top-down", { width: 5, height: 3, bits: 32, topDown: true }],
    ["32-bit BI_BITFIELDS with the usual masks", { width: 4, height: 3, bits: 32, compression: 3 }],
    ["24-bit with a larger (V4) header", { width: 3, height: 2, headerSize: 108 }],
  ];
  for (const [name, options] of shapes) {
    it(`converts ${name}`, () => {
      const png = bmpToPng(makeBmp(options));
      expect(png).toBeDefined();
      const decoded = decodePng(png!);
      expect(decoded).toMatchObject({ width: options.width, height: options.height, bitDepth: 8, colorType: 2 });
      for (let y = 0; y < options.height; y++) {
        for (let x = 0; x < options.width; x++) {
          // the BMP stores blue, green, red; the PNG wants red, green, blue
          expect(decoded.rgb(x, y)).toEqual([x + y, y * 10, x * 10]);
        }
      }
    });
  }
  it("drops the alpha byte of a 32-bit picture", () => {
    const png = bmpToPng(makeBmp({ width: 1, height: 1, bits: 32, pixel: () => [1, 2, 3, 0] }));
    expect(decodePng(png!).rgb(0, 0)).toEqual([3, 2, 1]);
  });

  const valid = makeBmp({ width: 2, height: 2 });
  const refusals: Array<[string, Uint8Array]> = [
    ["a palette (8 bits)", makeBmp({ width: 2, height: 2, bits: 24 }).map((value, index) => (index === 28 ? 8 : value))],
    ["16 bits", valid.map((value, index) => (index === 28 ? 16 : value))],
    ["run-length coding", valid.map((value, index) => (index === 30 ? 1 : value))],
    ["the old 12-byte header", valid.map((value, index) => (index === 14 ? 12 : value))],
    ["a header smaller than 40", valid.map((value, index) => (index === 14 ? 39 : value))],
    ["a truncated file", valid.subarray(0, valid.length - 1)],
    ["a file shorter than the headers", valid.subarray(0, 40)],
    ["a nonstandard colour mask", makeBmp({ width: 2, height: 2, bits: 32, compression: 3, masks: [0xff000000, 0x00ff0000, 0x0000ff00] })],
    ["BI_BITFIELDS with 24 bits", makeBmp({ width: 2, height: 2, bits: 24, compression: 3 })],
    ["zero width", makeBmp({ width: 1, height: 1 }).map((value, index) => (index >= 18 && index < 22 ? 0 : value))],
    ["a negative width", makeBmp({ width: 1, height: 1 }).map((value, index) => (index >= 18 && index < 22 ? 0xff : value))],
    ["zero height", makeBmp({ width: 1, height: 1 }).map((value, index) => (index >= 22 && index < 26 ? 0 : value))],
    [
      "an absurd size",
      (() => {
        const bytes = makeBmp({ width: 1, height: 1 });
        new DataView(bytes.buffer).setInt32(18, 100_000, true);
        new DataView(bytes.buffer).setInt32(22, 100_000, true);
        return bytes;
      })(),
    ],
    [
      "a data offset past the end",
      (() => {
        const bytes = makeBmp({ width: 1, height: 1 });
        new DataView(bytes.buffer).setUint32(10, 0xffffff00, true);
        return bytes;
      })(),
    ],
    ["not a BMP", new TextEncoder().encode("not a picture at all, long enough to pass the header length check......")],
  ];
  for (const [name, bytes] of refusals) {
    it(`refuses ${name}`, () => expect(bmpToPng(bytes)).toBeUndefined());
  }
});
