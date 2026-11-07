import { deflateSync } from "node:zlib";

/** The smallest valid-looking PNG bytes for tests that only need an image file to exist. */
export function solidPngBytes(): Buffer {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), deflateSync(Buffer.from("x"))]);
}
