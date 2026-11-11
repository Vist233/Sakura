import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import { serveProcess } from "../../src/acp/serve.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { makeSandbox } from "../support/harness.ts";

describe("serveProcess", () => {
  it("sends console output to stderr so it can never corrupt the protocol stream, and restores nothing it did not change", async () => {
    const sandbox = await makeSandbox();
    const original = { log: console.log, error: console.error, info: console.info, warn: console.warn, debug: console.debug };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const seenOut: string[] = [];
    const seenErr: string[] = [];
    stdout.on("data", (chunk: Buffer) => seenOut.push(chunk.toString()));
    stderr.on("data", (chunk: Buffer) => seenErr.push(chunk.toString()));
    try {
      const done = serveProcess({ stdin, stdout, stderr, env: {} }, { settings: DEFAULT_SETTINGS, store: createSessionStore(sandbox.directory), version: "0.0.0", permissions: "auto" });
      console.log("a stray line", 42);
      console.info("another");
      stdin.end();
      assert.equal(await done, 0);
      assert.deepEqual(seenOut, []);
      assert.match(seenErr.join(""), /a stray line 42/);
      assert.match(seenErr.join(""), /another/);
    } finally {
      Object.assign(console, original);
      await sandbox.cleanup();
    }
  });
});
