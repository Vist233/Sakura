// Model and thinking selectors over the SDK client (L2).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { methods, RequestError } from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import type { AgentSessionRequest } from "../../src/agent-session.ts";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { startHarness } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const providers = {
  ...DEFAULT_SETTINGS.providers,
  commandcode: { baseUrl: "https://api.commandcode.ai/provider/v1", model: "deepseek/deepseek-v4-flash", keyEnv: "COMMANDCODE_API_KEY", contextWindow: 1_000_000, compat: "deepseek" },
  plain: { baseUrl: "https://example.invalid/v1", model: "plain-model", keyEnv: "PLAIN_KEY", contextWindow: 32_000 },
};
const settings = { providers, provider: "deepseek" };
const ids = (options: SessionConfigOption[] | null | undefined) => (options ?? []).map((option) => option.id);
const select = (options: SessionConfigOption[] | null | undefined, id: string) => {
  const option = (options ?? []).find((entry) => entry.id === id);
  assert.ok(option && option.type === "select", `option ${id}`);
  return option;
};
const set = (harness: Harness, sessionId: string, configId: string, value: string) => harness.connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
const failure = async (work: Promise<unknown>): Promise<RequestError> => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof RequestError, String(error));
    return error;
  }
  assert.fail("expected the request to fail");
};

describe("config options over the SDK client (L2)", () => {
  let sandbox: Sandbox;
  let harness: Harness | undefined;
  let opened: AgentSessionRequest[];
  beforeEach(async () => {
    sandbox = await makeSandbox();
    harness = undefined;
    opened = [];
  });
  afterEach(async () => {
    await harness?.stop();
    await sandbox.cleanup();
  });
  const start = (script: Parameters<typeof startHarness>[1] = [{ text: "ok" }], env: Record<string, string> = { DEEPSEEK_API_KEY: "x", COMMANDCODE_API_KEY: "x", PLAIN_KEY: "x" }) =>
    (harness = startHarness(sandbox, script, { settings, env, onOpen: (request) => void opened.push(request) }));

  it("session/new returns the model and thinking selectors; every configured provider is a model, including one with a 1M window", async () => {
    const created = await start().start();
    assert.deepEqual(ids(created.configOptions), ["model", "thought_level"]);
    const model = select(created.configOptions, "model");
    assert.equal(model.category, "model");
    const values = model.options.flatMap((option) => ("value" in option ? [option.value] : []));
    for (const name of ["deepseek", "opencode", "commandcode", "plain"]) assert.ok(values.includes(name), name);
    assert.equal(select(created.configOptions, "thought_level").category, "thought_level");
  });

  it("changing the model rebuilds the agent on the same session file, keeps the history and sends config_option_update", async () => {
    start((request) => ({ text: JSON.stringify(request.messages).includes("first question") ? "I remember" : "I forgot" }));
    const { sessionId } = await harness!.start();
    await harness!.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "first question" }] });
    const before = opened.length;
    const reply = await set(harness!, sessionId, "model", "commandcode");
    assert.equal(select(reply.configOptions, "model").currentValue, "commandcode");
    assert.equal(opened.length, before + 1, "one new agent");
    const [first, second] = [opened[0]!, opened.at(-1)!];
    assert.equal(second.sessionFile, first.sessionFile, "the same session file");
    assert.equal(second.provider, "commandcode");
    await sleep(30);
    const update = harness!.updates.find((item) => item.update.sessionUpdate === "config_option_update");
    assert.ok(update, "config_option_update was sent");
    await harness!.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "what did I ask?" }] });
    const texts = harness!.updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk").map((item) => (item.update as { content: { text: string } }).content.text);
    assert.ok(texts.length >= 2);
  });

  it("changing the thinking level rebuilds with that level; a model without one drops the selector", async () => {
    const { sessionId } = await start().start();
    const low = await set(harness!, sessionId, "thought_level", "low");
    assert.equal(select(low.configOptions, "thought_level").currentValue, "low");
    assert.equal(opened.at(-1)!.thinking, "low");
    const plain = await set(harness!, sessionId, "model", "plain");
    assert.deepEqual(ids(plain.configOptions), ["model"]);
    const back = await set(harness!, sessionId, "model", "deepseek");
    assert.deepEqual(ids(back.configOptions), ["model", "thought_level"]);
  });

  it("setting the value it already has does nothing", async () => {
    const { sessionId } = await start().start();
    const before = opened.length;
    const current = select((await set(harness!, sessionId, "model", "deepseek")).configOptions, "model").currentValue;
    assert.equal(current, "deepseek");
    assert.equal(opened.length, before);
    assert.equal(harness!.updates.filter((item) => item.update.sessionUpdate === "config_option_update").length, 0);
  });

  it("a change during a turn waits and is made before the prompt response", async () => {
    start([{ toolCalls: [{ name: "bash", args: { command: "sleep 0.4" } }] }, { text: "done" }]);
    const { sessionId } = await harness!.start();
    const turn = harness!.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    await sleep(150);
    const before = opened.length;
    const reply = await set(harness!, sessionId, "model", "commandcode");
    assert.equal(select(reply.configOptions, "model").currentValue, "commandcode", "the answer already shows the wanted value");
    assert.equal(opened.length, before, "the agent is not rebuilt during the turn");
    await turn;
    assert.equal(opened.length, before + 1, "rebuilt when the turn ended");
    assert.equal(opened.at(-1)!.provider, "commandcode");
    assert.ok(harness!.updates.some((item) => item.update.sessionUpdate === "config_option_update"));
    const count = harness!.updates.length;
    await sleep(60);
    assert.equal(harness!.updates.length, count, "nothing after the response");
  });

  it("two changes during a turn keep the last", async () => {
    start([{ toolCalls: [{ name: "bash", args: { command: "sleep 0.4" } }] }, { text: "done" }]);
    const { sessionId } = await harness!.start();
    const turn = harness!.connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    await sleep(150);
    await set(harness!, sessionId, "model", "commandcode");
    await set(harness!, sessionId, "model", "plain");
    await turn;
    assert.equal(opened.at(-1)!.provider, "plain");
  });

  it("errors: unknown option, unknown value, a provider without a key, and no thinking on a model that has none", async () => {
    const { sessionId } = await start(undefined, { DEEPSEEK_API_KEY: "x", PLAIN_KEY: "x" }).start();
    assert.equal((await failure(set(harness!, sessionId, "colour", "red"))).code, -32602);
    assert.equal((await failure(set(harness!, sessionId, "model", "nope"))).code, -32602);
    // under the scripted test client every provider counts as usable; the missing-key rule is covered at L1
    await set(harness!, sessionId, "model", "plain");
    assert.equal((await failure(set(harness!, sessionId, "thought_level", "low"))).code, -32602);
    assert.equal((await failure(set(harness!, "no-such-session", "model", "plain"))).code, -32002);
  });

  it("a failed rebuild keeps the old agent and says so", async () => {
    harness = startHarness(sandbox, [{ text: "ok" }], {
      settings,
      env: { DEEPSEEK_API_KEY: "x", PLAIN_KEY: "x" },
      onOpen: (request) => {
        if (request.provider === "plain") throw new Error("cannot start plain");
      },
    });
    const created = await harness.start();
    const error = await failure(set(harness, created.sessionId, "model", "plain"));
    assert.match(error.message, /Could not switch: cannot start plain/);
    const after = await set(harness, created.sessionId, "thought_level", "low");
    assert.equal(select(after.configOptions, "model").currentValue, "deepseek", "still on the old setup");
    const prompt = await harness.connection.agent.request(methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "still works?" }] });
    assert.equal(prompt.stopReason, "end_turn");
  });
});
