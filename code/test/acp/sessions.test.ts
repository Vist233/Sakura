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

  it("keeps the chosen thinking level when the session is loaded again", async () => {
    const store = createSessionStore(join(sandbox.directory, "sessions"));
    const levels: Array<string | undefined> = [];
    const build = () =>
      createSessions({
        settings: { ...DEFAULT_SETTINGS, provider: "deepseek" },
        store,
        env: { DEEPSEEK_API_KEY: "x" },
        permissions: "auto",
        allowFullAccess: false,
        log: createLogger(() => undefined, "off"),
        clients: { agent: undefined as never },
        open: async (request) => {
          levels.push(request.thinking);
          const { session } = await openScripted(sandbox, [{ text: "ok" }]);
          return Object.assign(session, { thinking: request.thinking });
        },
      });
    const first = build();
    const id = await first.create(sandbox.directory);
    await first.setConfig(id, "reasoning_effort", "high");
    await first.run(id, "hello", async () => undefined);
    await first.closeAll();
    assert.equal((await store.get(id))?.thinking, "high");
    const second = build();
    await second.load(id, sandbox.directory);
    assert.equal(levels.at(-1), "high");
    const level = second.configOptions(id).find((option) => option.id === "reasoning_effort");
    assert.equal(level?.currentValue, "high");
    await second.closeAll();
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

  it("a prompt that arrives during an idle compaction waits for it and then runs; it is not refused as busy", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fakeAgent = {
      context: async () => ({ tokens: 5000, window: 100_000, free: 95_000, compactAt: 83_000 }),
      log: { branch: async () => [] },
      run: (input: unknown, options?: { compact?: boolean }) => {
        const compact = options?.compact === true;
        order.push(compact ? "compaction starts" : "prompt starts");
        return {
          events: (async function* () {
            if (compact) {
              await gate;
              yield { type: "compaction", tokensBefore: 5000 };
              order.push("compaction ends");
            }
          })(),
          result: Promise.resolve({ reason: "done" }),
          cancel() {},
        };
      },
      close: async () => undefined,
    };
    const store = createSessionStore(join(sandbox.directory, "sessions"));
    const sessions = createSessions({
      settings: DEFAULT_SETTINGS,
      store,
      env: {},
      permissions: "auto",
      allowFullAccess: false,
      log: createLogger(() => undefined, "off"),
      clients: { agent: undefined as never },
      open: async () => ({ agent: fakeAgent, provider: "scripted", model: "m", contextWindow: 100_000, thinking: undefined, permissions: "auto", redaction: false, sessionId: "x", close: async () => undefined }) as never,
    });
    const id = await sessions.create(sandbox.directory);
    const compacting = sessions.compactIdle(id, 1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessions.busy(id), true);
    const prompt = sessions.run(id, "hello", async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["compaction starts"], "the prompt has not started yet");
    release();
    await compacting;
    assert.equal((await prompt).result.reason, "done");
    assert.deepEqual(order, ["compaction starts", "compaction ends", "prompt starts"]);
    await sessions.closeAll();
  });
});
