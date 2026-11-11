import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { providerFor } from "../../src/acp/auth.ts";
import { createLogger } from "../../src/acp/log.ts";
import { createSessions } from "../../src/acp/sessions.ts";
import { AcpError } from "../../src/acp/types.ts";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { makeSandbox, openScripted } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";

describe("providerFor (L1)", () => {
  it("returns the chosen provider when its key is set, and never reads the value", () => {
    assert.equal(providerFor({ ...DEFAULT_SETTINGS, provider: "deepseek" }, { DEEPSEEK_API_KEY: "x" }), "deepseek");
    assert.equal(providerFor(DEFAULT_SETTINGS, { OPENCODE_API_KEY: "x" }), "opencode");
  });

  it("asks for authentication, naming the variable, when the chosen provider has no key", () => {
    assert.throws(
      () => providerFor({ ...DEFAULT_SETTINGS, provider: "opencode" }, {}),
      (error) => error instanceof AcpError && error.code === -32000 && /OPENCODE_API_KEY/.test(error.message) && (error.data as { keyEnv: string }).keyEnv === "OPENCODE_API_KEY",
    );
  });

  it("asks for authentication when no provider has a key, and when the chosen one is unknown", () => {
    for (const settings of [DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, provider: "nope" }]) {
      assert.throws(() => providerFor(settings, {}), (error) => error instanceof AcpError && error.code === -32000);
    }
  });
});

describe("sessions (L1, with a scripted agent)", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  const make = (script: Parameters<typeof openScripted>[1]) => {
    const store = createSessionStore(join(sandbox.directory, "sessions"));
    return createSessions({ settings: DEFAULT_SETTINGS, store, env: {}, permissions: "auto", allowFullAccess: false, log: createLogger(() => undefined, "off"), clients: { agent: undefined as never }, open: async () => (await openScripted(sandbox, script)).session });
  };

  it("titles the session from the first prompt so it shows in `sakuracode sessions`", async () => {
    const store = createSessionStore(join(sandbox.directory, "sessions"));
    const sessions = createSessions({ settings: DEFAULT_SETTINGS, store, env: {}, permissions: "auto", allowFullAccess: false, log: createLogger(() => undefined, "off"), clients: { agent: undefined as never }, open: async () => (await openScripted(sandbox, [{ text: "ok" }])).session });
    const id = await sessions.create(sandbox.directory);
    assert.equal((await store.get(id))?.title, undefined);
    await sessions.run(id, "fix the build please", async () => undefined);
    assert.equal((await store.get(id))?.title, "fix the build please");
    await sessions.closeAll();
  });

  it("a failing event sink cancels the run and the session can be used again", async () => {
    const sessions = make([{ text: "one two three", chunkSize: 3 }, { text: "again" }]);
    const id = await sessions.create(sandbox.directory);
    await assert.rejects(
      sessions.run(id, "go", async () => {
        throw new Error("client went away");
      }),
      /client went away/,
    );
    const turn = await sessions.run(id, "again", async () => undefined);
    assert.equal(turn.result.reason, "done");
    await sessions.closeAll();
  });

  it("closeAll cancels a running turn", async () => {
    const sessions = make([{ hang: true }]);
    const id = await sessions.create(sandbox.directory);
    const running = sessions.run(id, "hang", async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await sessions.closeAll();
    assert.equal((await running).cancelled, true);
    assert.equal(sessions.has(id), false);
  });
});
