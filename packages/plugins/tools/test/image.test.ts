import { describe, expect, it } from "vitest";
import { sniffImageType } from "../src/builtin/image.ts";

describe("sniffImageType", () => {
  const cases: Array<[string, number[], string]> = [
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0], "image/png"],
    ["jpeg", [0xff, 0xd8, 0xff, 0xe0, 0], "image/jpeg"],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    ["webp", [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    ["bmp", [0x42, 0x4d, 0, 0], "image/bmp"],
    ["tiff (little endian)", [0x49, 0x49, 0x2a, 0x00], "image/tiff"],
    ["tiff (big endian)", [0x4d, 0x4d, 0x00, 0x2a], "image/tiff"],
    ["ico", [0x00, 0x00, 0x01, 0x00], "image/x-icon"],
  ];
  for (const [name, bytes, type] of cases) it(`recognises ${name}`, () => expect(sniffImageType(Uint8Array.from(bytes))).toBe(type));

  it("returns undefined for junk, text, empty input and a RIFF file that is not webp", () => {
    expect(sniffImageType(new TextEncoder().encode("hello world"))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
    expect(sniffImageType(Uint8Array.from([0x89, 0x50]))).toBeUndefined();
    expect(sniffImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
  });
});
