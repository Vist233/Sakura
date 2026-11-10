import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { imageMediaType, pastedImagePath } from "../src/images.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";

describe("images", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeFile(join(sandbox.directory, "my shot.png"), "x");
    await writeFile(join(sandbox.directory, "notes.txt"), "x");
  });
  afterEach(() => sandbox.cleanup());

  it("knows image types by extension", () => {
    assert.equal(imageMediaType("a.JPG"), "image/jpeg");
    assert.equal(imageMediaType("a.txt"), undefined);
  });

  it("recognises a dropped or pasted image path (quoted, escaped spaces, relative)", () => {
    const path = join(sandbox.directory, "my shot.png");
    assert.equal(pastedImagePath(`'${path}'`, sandbox.directory), path);
    assert.equal(pastedImagePath(path.replace(/ /g, "\\ "), sandbox.directory), path);
    assert.equal(pastedImagePath("my shot.png", sandbox.directory), path);
    assert.equal(pastedImagePath(`file://${path}`, sandbox.directory), path);
  });

  it("ignores text, missing files, non-images and several lines", () => {
    assert.equal(pastedImagePath("hello world", sandbox.directory), undefined);
    assert.equal(pastedImagePath("missing.png", sandbox.directory), undefined);
    assert.equal(pastedImagePath(join(sandbox.directory, "notes.txt"), sandbox.directory), undefined);
    assert.equal(pastedImagePath("a.png\nb.png", sandbox.directory), undefined);
  });
});
