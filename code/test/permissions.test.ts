import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGuards, nextPermission, PERMISSION_NAMES, PERMISSION_PRESETS } from "../src/permissions.ts";
import { scriptedClient } from "./support/scripted-client.ts";

const reviewLlm = scriptedClient([]);
const names = (plugins: Array<{ name: string }>) => plugins.map((plugin) => plugin.name);

describe("permissions", () => {
  it("defaults the product way: review on, redaction off", () => {
    const guards = buildGuards({ permissions: "auto", redaction: false, reviewLlm });
    assert.deepEqual(names(guards.plugins), ["review"]);
    assert.equal(guards.tools, undefined);
  });

  it("redaction is opt-in and comes before review", () => {
    assert.deepEqual(names(buildGuards({ permissions: "auto", redaction: true, reviewLlm }).plugins), ["redaction", "review"]);
  });

  it("full-access installs no review", () => {
    assert.deepEqual(names(buildGuards({ permissions: "full-access", redaction: false, reviewLlm }).plugins), []);
  });

  it("read-only keeps review and removes every tool but read", () => {
    const guards = buildGuards({ permissions: "read-only", redaction: false, reviewLlm });
    assert.deepEqual(names(guards.plugins), ["review"]);
    assert.deepEqual(guards.tools, ["read"]);
  });

  it("no preset restricts the working directory (there is no such field)", () => {
    for (const name of PERMISSION_NAMES) assert.deepEqual(Object.keys(PERMISSION_PRESETS[name]).sort(), ["breakerConsecutive", "name", "review", "summary", "tools"]);
  });
});

describe("nextPermission", () => {
  it("cycles auto, strict, read-only and never lands on full-access", () => {
    assert.equal(nextPermission("auto"), "strict");
    assert.equal(nextPermission("strict"), "read-only");
    assert.equal(nextPermission("read-only"), "auto");
    assert.equal(nextPermission("full-access"), "auto");
  });
});
