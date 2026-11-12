// L3: the real binary over real pipes. Stdout must carry protocol lines and nothing else.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { ClientConnection, SessionNotification } from "@agentclientprotocol/sdk";

const binary = new URL("../../bin/sakuracode.mjs", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Running {
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  updates: SessionNotification[];
  stdout: string[];
  stderr: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  startedAt: number;
}

describe("sakuracode acp as a real process (L3)", () => {
  let directory: string;
  let running: Running | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sakuracode-acp-"));
    running = undefined;
  });
  afterEach(async () => {
    running?.child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });

  async function launch(turns: unknown[] | undefined, env: Record<string, string> = {}, args: string[] = []): Promise<Running> {
    const script = join(directory, "script.json");
    if (turns) await writeFile(script, JSON.stringify(turns));
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", binary, "acp", ...args], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? "", HOME: directory, SAKURA_HOME: join(directory, "home"), ...(turns ? { SAKURACODE_FAUX_SCRIPT: script } : {}), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const lines = (target: string[]) => {
      let pending = "";
      return (chunk: Buffer) => {
        pending += chunk.toString();
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        target.push(...parts);
      };
    };
    const tee = new PassThrough();
    child.stdout.on("data", lines(stdout));
    child.stdout.pipe(tee);
    child.stderr.on("data", lines(stderr));
    const updates: SessionNotification[] = [];
    const connection = client()
      .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
      .connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(tee) as ReadableStream<Uint8Array>));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    running = { child, connection, updates, stdout, stderr, exit, startedAt: Date.now() };
    return running;
  }

  const handshake = async (r: Running) => {
    await r.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    return r.connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] });
  };
  const assertProtocolOnly = (lines: string[]) => {
    for (const line of lines) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0", `not a protocol line on stdout: ${line.slice(0, 120)}`);
    }
  };

  it("serves a whole session; stdout has only JSON-RPC lines, stderr only JSON log lines", async () => {
    const r = await launch([{ reasoning: "hm", text: "Hello over pipes" }], { SAKURACODE_ACP_LOG: "info" });
    const started = await handshake(r);
    const initializedAfter = Date.now() - r.startedAt;
    const response = await r.connection.agent.request(methods.agent.session.prompt, { sessionId: started.sessionId, prompt: [{ type: "text", text: "hi" }] });
    assert.equal(response.stopReason, "end_turn");
    assert.ok(r.updates.some((item) => item.update.sessionUpdate === "agent_message_chunk"));
    assert.ok(r.stdout.length >= 4, "initialize, session/new, updates and the prompt response");
    assertProtocolOnly(r.stdout);
    assert.ok(r.stderr.length > 0, "the logs go to stderr");
    for (const line of r.stderr) assert.equal(typeof (JSON.parse(line) as { level?: string }).level, "string", line);
    console.log(`acp startup to a created session: ${initializedAfter} ms`);
    assert.ok(initializedAfter < 8000, `startup took ${initializedAfter} ms`);
  });

  it("session/new lists the providers of the config file as models, and set_config_option switches over real pipes", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "home"), { recursive: true });
    await writeFile(
      join(directory, "home", "config.toml"),
      '[providers.commandcode]\nbase_url = "https://api.commandcode.ai/provider/v1"\nmodel = "deepseek/deepseek-v4-flash"\nkey_env = "COMMANDCODE_API_KEY"\ncontext_window = 1000000\ncompat = "deepseek"\n',
    );
    const r = await launch([{ text: "x" }], { COMMANDCODE_API_KEY: "test-not-a-key" });
    const created = await handshake(r);
    const model = (created.configOptions ?? []).find((option) => option.id === "model");
    assert.ok(model && model.type === "select");
    const values = model.options.flatMap((option) => ("value" in option ? [option.value] : []));
    assert.ok(values.includes("commandcode"), values.join(","));
    const names = model.options.flatMap((option) => ("name" in option ? [option.name] : []));
    assert.ok(names.includes("deepseek/deepseek-v4-flash (commandcode)"));
    const changed = await r.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: created.sessionId, configId: "model", value: "commandcode" });
    assert.equal(changed.configOptions.find((option) => option.id === "model")?.currentValue, "commandcode");
    assertProtocolOnly(r.stdout);
  });

  it("tool cards, the context meter and the command menu travel over real pipes, and stdout stays protocol-only", async () => {
    const r = await launch([{ toolCalls: [{ name: "bash", id: "p1", args: { command: "echo over-the-pipe" } }] }, { text: "done", usage: { input: 2000, output: 20, cacheRead: 0, cacheWrite: 0 } }], {}, ["--yolo"]);
    const started = await handshake(r);
    await r.connection.agent.request(methods.agent.session.prompt, { sessionId: started.sessionId, prompt: [{ type: "text", text: "run" }] });
    const kinds = r.updates.map((item) => item.update.sessionUpdate);
    for (const kind of ["tool_call", "tool_call_update", "usage_update", "agent_message_chunk"] as const) assert.ok(kinds.includes(kind), `${kind} in ${kinds.join(",")}`);
    assertProtocolOnly(r.stdout);
    await sleep(100);
    assert.ok(r.updates.some((item) => item.update.sessionUpdate === "available_commands_update"));
  });

  it("closing stdin ends the process with exit code 0", async () => {
    const r = await launch([{ text: "x" }]);
    await handshake(r);
    r.child.stdin.end();
    const done = await Promise.race([r.exit, sleep(5000).then(() => undefined)]);
    assert.ok(done, "the process did not exit");
    assert.equal(done.code, 0);
    assertProtocolOnly(r.stdout);
  });

  it("SIGTERM during a running turn ends the process cleanly", async () => {
    const r = await launch([{ hang: true }]);
    const started = await handshake(r);
    const pending = r.connection.agent.request(methods.agent.session.prompt, { sessionId: started.sessionId, prompt: [{ type: "text", text: "wait" }] }).catch(() => undefined);
    await sleep(300);
    r.child.kill("SIGTERM");
    const done = await Promise.race([r.exit, sleep(5000).then(() => undefined)]);
    assert.ok(done, "the process did not exit");
    assert.equal(done.code, 0);
    await pending;
    assertProtocolOnly(r.stdout);
  });

  it("without a key and without the test hook, session/new asks for authentication and stdout stays clean", async () => {
    const r = await launch(undefined);
    await r.connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await assert.rejects(r.connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] }), (error: { code?: number; message: string }) => error.code === -32000 && /API_KEY/.test(error.message));
    assertProtocolOnly(r.stdout);
    r.child.stdin.end();
    assert.equal((await r.exit).code, 0);
  });

  it("review mode: auto by default, never full-access from the config file alone, and what the command line asks for", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "home"), { recursive: true });
    await writeFile(join(directory, "home", "config.toml"), 'permissions = "full-access"\n');
    const modes: string[] = [];
    const offered: boolean[] = [];
    for (const args of [[], ["--permissions", "strict"], ["--yolo"]]) {
      const r = await launch([{ text: "x" }], { SAKURACODE_ACP_LOG: "info" }, args);
      const started = await handshake(r);
      r.child.stdin.end();
      await r.exit;
      modes.push(/"permissions":"([a-z-]+)"/.exec(r.stderr.join("\n"))?.[1] ?? "none");
      const mode = (started.configOptions ?? []).find((option) => option.id === "mode");
      offered.push(mode && mode.type === "select" ? mode.options.flatMap((option) => ("value" in option ? [option.value] : [])).includes("full-access") : false);
    }
    assert.deepEqual(modes, ["auto", "strict", "full-access"]);
    assert.deepEqual(offered, [false, false, true], "full-access is a choice for the client only when it was asked for on the command line");
  });

  it("garbage on stdin gets a JSON-RPC error, not a crash or stray output", async () => {
    const r = await launch([{ text: "x" }]);
    r.child.stdin.write("this is not json\n");
    await sleep(300);
    assertProtocolOnly(r.stdout);
    await handshake(r);
    assert.equal(r.child.exitCode, null, "still running");
  });
});
