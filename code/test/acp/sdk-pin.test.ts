import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { summariseSchema } from "./schema-summary.ts";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
const fixtureUrl = new URL("./fixtures/protocol-v1.json", import.meta.url);

describe("ACP SDK pin", () => {
  it("is an exact version, not a range", () => {
    assert.match(manifest.dependencies["@agentclientprotocol/sdk"] ?? "", /^\d+\.\d+\.\d+$/);
  });

  it("is the version that is installed", () => {
    assert.equal(summariseSchema().sdkVersion, manifest.dependencies["@agentclientprotocol/sdk"]);
  });

  it("speaks ACP protocol version 1", () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });

  it("has the wire format that was recorded (UPDATE_ACP_FIXTURES=1 records a new one on purpose)", () => {
    const current = summariseSchema();
    if (process.env.UPDATE_ACP_FIXTURES === "1") writeFileSync(fixtureUrl, `${JSON.stringify(current, null, 2)}\n`);
    assert.deepEqual(current, JSON.parse(readFileSync(fixtureUrl, "utf8")));
  });

  it("covers every method and update kind the plan relies on", () => {
    const summary = JSON.parse(readFileSync(fixtureUrl, "utf8")) as ReturnType<typeof summariseSchema>;
    for (const method of ["initialize", "authenticate", "session/new", "session/prompt", "session/cancel", "session/load", "session/set_mode", "session/set_config_option", "session/update", "session/request_permission"]) {
      assert.ok(summary.methods.includes(method), method);
    }
    for (const kind of ["agent_message_chunk", "agent_thought_chunk", "user_message_chunk", "tool_call", "tool_call_update", "plan", "usage_update", "available_commands_update", "config_option_update", "current_mode_update", "compaction_update"]) {
      assert.ok(summary.variants.SessionUpdate?.includes(kind), kind);
    }
    assert.deepEqual(summary.variants.StopReason, ["cancelled", "end_turn", "max_tokens", "max_turn_requests", "refusal"]);
    assert.ok(Object.values(summary.shapes).every((shape) => shape !== "missing"), JSON.stringify(summary.shapes));
  });
});
