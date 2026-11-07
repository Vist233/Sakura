import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Tool } from "@sakura/kernel";
import { connectMcp } from "../src/index.ts";
import type { McpConnection, McpServerConfig } from "../src/index.ts";

const server = fileURLToPath(new URL("./fake-mcp-server.mjs", import.meta.url));
const config = (mode = "normal") => ({ command: process.execPath, args: [server, mode] });
const context = (signal = new AbortController().signal) => ({ env: undefined as never, signal, callId: "t", log: undefined as never, notify: () => undefined, watch: () => () => undefined });
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("");

let open: McpConnection[] = [];
afterEach(async () => {
  await Promise.all(open.map((connection) => connection.close()));
  open = [];
});
async function connect(servers: Record<string, McpServerConfig>, timeoutMs = 3000) {
  const connection = await connectMcp(servers, { timeoutMs });
  open.push(connection);
  return connection;
}
const find = (connection: McpConnection, name: string): Tool => connection.tools.find((tool) => tool.name === name)!;

describe("connecting", () => {
  it("lists the tools of a server under mcp__server__tool names", async () => {
    const connection = await connect({ fake: config() });
    expect(connection.status.fake).toEqual({ ok: true, toolCount: 6 });
    expect(connection.tools.map((tool) => tool.name)).toContain("mcp__fake__echo");
  });

  it("follows pagination", async () => {
    const connection = await connect({ fake: config("paged") });
    expect(connection.tools).toHaveLength(6);
  });

  it("a server that exits at once is reported and does not stop the others", async () => {
    const connection = await connect({ broken: config("exit-at-once"), good: config() });
    expect(connection.status.broken?.ok).toBe(false);
    expect(connection.status.broken?.error).toBeTruthy();
    expect(connection.status.good?.ok).toBe(true);
    expect(connection.tools.every((tool) => tool.name.startsWith("mcp__good__"))).toBe(true);
  });

  it("a server that never answers times out", async () => {
    const started = Date.now();
    const connection = await connect({ quiet: config("silent") }, 300);
    expect(connection.status.quiet?.ok).toBe(false);
    expect(connection.status.quiet?.error).toContain("no answer");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("a command that does not exist is reported", async () => {
    const connection = await connect({ missing: { command: "/no/such/program" } });
    expect(connection.status.missing?.ok).toBe(false);
  });

  it("several servers connect together and keep the configured order", async () => {
    const connection = await connect({ one: config(), two: config() });
    const names = connection.tools.map((tool) => tool.name);
    expect(names.indexOf("mcp__one__echo")).toBeLessThan(names.indexOf("mcp__two__echo"));
    expect(names.filter((name) => name.startsWith("mcp__one__")).length).toBe(6);
  });

  it("no servers gives an empty connection", async () => {
    const connection = await connect({});
    expect(connection.tools).toEqual([]);
    expect(connection.status).toEqual({});
  });
});

describe("tool declarations follow the server's hints", () => {
  it("maps hints to effect and replay", async () => {
    const connection = await connect({ fake: config() });
    expect(find(connection, "mcp__fake__echo")).toMatchObject({ effect: "read", replay: "safe" });
    expect(find(connection, "mcp__fake__delete_all")).toMatchObject({ effect: "irreversible", replay: "never" });
    expect(find(connection, "mcp__fake__fetch")).toMatchObject({ effect: "network", replay: "never" });
    expect(find(connection, "mcp__fake__plain")).toMatchObject({ effect: "exec", replay: "never" });
  });

  it("keeps the description and the input schema", async () => {
    const connection = await connect({ fake: config() });
    const echo = find(connection, "mcp__fake__echo");
    expect(echo.description).toBe("Echo the text back");
    expect(echo.parameters).toMatchObject({ properties: { text: { type: "string" } } });
  });
});

describe("calling", () => {
  it("returns the server's text", async () => {
    const connection = await connect({ fake: config() });
    const result = await find(connection, "mcp__fake__echo").execute({ text: "hello" }, context());
    expect(textOf(result as never)).toBe("echo: hello");
    expect(result.isError).toBeUndefined();
  });

  it("passes isError through", async () => {
    const connection = await connect({ fake: config() });
    const result = await find(connection, "mcp__fake__fail").execute({}, context());
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toBe("it broke");
  });

  it("a protocol error becomes an error result", async () => {
    const connection = await connect({ fake: config() });
    const result = await find(connection, "mcp__fake__plain").execute({}, context());
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain("protocol failure");
  });

  it("long text keeps the head and the tail", async () => {
    const connection = await connect({ fake: config() });
    const result = await find(connection, "mcp__fake__big").execute({}, context());
    const text = textOf(result as never);
    expect(text.length).toBeLessThan(21_000);
    expect(text).toContain("output cut");
  });

  it("images are not forwarded as raw data but do not break the result", async () => {
    const connection = await connect({ fake: config() });
    const result = await find(connection, "mcp__fake__fetch").execute({}, context());
    expect(textOf(result as never)).toContain("ok");
    expect(textOf(result as never)).toContain("image content not shown");
  });

  it("after close() a call reports that the server is gone", async () => {
    const connection = await connect({ fake: config() });
    await connection.close();
    await new Promise((done) => setTimeout(done, 100));
    const result = await find(connection, "mcp__fake__echo").execute({ text: "x" }, context());
    expect(result.isError).toBe(true);
  });

  it("parallel calls get their own answers", async () => {
    const connection = await connect({ fake: config() });
    const echo = find(connection, "mcp__fake__echo");
    const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => echo.execute({ text: `n${index}` }, context())));
    expect(answers.map((answer) => textOf(answer as never))).toEqual(Array.from({ length: 12 }, (_, index) => `echo: n${index}`));
  });
});

describe("the protocol exchange, exactly", () => {
  it("starts with initialize, the initialized notification and tools/list, with increasing ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
    const log = join(dir, "log.jsonl");
    try {
      await connect({ fake: { ...config("record"), env: { FAKE_MCP_LOG: log } } });
      const sent = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sent).toEqual([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sakura", version: "0.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a call sends tools/call with the name the server knows and the arguments (an empty object when there are none)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
    const log = join(dir, "log.jsonl");
    try {
      const connection = await connect({ fake: { ...config("record"), env: { FAKE_MCP_LOG: log } } });
      await find(connection, "mcp__fake__echo").execute({ text: "a" }, context());
      await find(connection, "mcp__fake__echo").execute(undefined, context());
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((message) => message.method === "tools/call");
      expect(calls).toEqual([
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "a" } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: {} } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancelling a call tells the server, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
    const log = join(dir, "log.jsonl");
    try {
      const connection = await connect({ fake: { ...config("record"), env: { FAKE_MCP_LOG: log } } });
      const controller = new AbortController();
      const pending = find(connection, "mcp__fake__echo").execute({ text: "a" }, context(controller.signal));
      controller.abort();
      await pending;
      await new Promise((done) => setTimeout(done, 100));
      const cancels = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((message) => message.method === "notifications/cancelled");
      expect(cancels).toEqual([{ jsonrpc: "2.0", method: "notifications/cancelled", params: { reason: "the run was cancelled" } }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a call that has finished does not cancel anything when the run is aborted later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
    const log = join(dir, "log.jsonl");
    try {
      const connection = await connect({ fake: { ...config("record"), env: { FAKE_MCP_LOG: log } } });
      const controller = new AbortController();
      await find(connection, "mcp__fake__echo").execute({ text: "a" }, context(controller.signal));
      controller.abort();
      await new Promise((done) => setTimeout(done, 100));
      expect(readFileSync(log, "utf8")).not.toContain("notifications/cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborting only tells the server; the call goes on waiting for its answer", async () => {
    const connection = await connect({ fake: config("hang-call") });
    const controller = new AbortController();
    const pending = find(connection, "mcp__fake__echo").execute({ text: "a" }, context(controller.signal));
    controller.abort();
    expect(await Promise.race([pending, new Promise((done) => setTimeout(() => done("still waiting"), 300))])).toBe("still waiting");
  });
});

describe("what comes back, exactly", () => {
  const call = async (name: string, args: unknown = {}) => {
    const connection = await connect({ fake: config("shapes") });
    return find(connection, `mcp__fake__${name}`).execute(args, context());
  };

  it("no result at all", async () => expect(await call("no_result")).toEqual({ content: [{ type: "text", text: "(no content)" }] }));
  it("a result without content", async () => expect(await call("no_content")).toEqual({ content: [{ type: "text", text: "(no content)" }] }));
  it("an empty content list", async () => expect(await call("empty")).toEqual({ content: [{ type: "text", text: "(no output)" }] }));
  it("parts that are not text are named, and text is kept", async () =>
    expect(await call("weird")).toEqual({
      content: [
        { type: "text", text: "[resource content not shown]" },
        { type: "text", text: "kept" },
        { type: "text", text: "[undefined content not shown]" },
      ],
    }));
  it("a text part whose text is not a string is not shown", async () => expect(await call("number_text")).toEqual({ content: [{ type: "text", text: "[text content not shown]" }] }));
  it("an error without a message says the request failed", async () =>
    expect(await call("bare_error")).toEqual({ content: [{ type: "text", text: "MCP call failed: request failed" }], isError: true }));

  it("text of exactly 20000 bytes is kept whole; one more is cut in the middle", async () => {
    const whole = await call("slow_n", { n: 20_000 });
    expect(textOf(whole as never)).toBe("x".repeat(20_000));
    const over = await call("slow_n", { n: 20_001 });
    expect(textOf(over as never)).toBe(`${"x".repeat(10_000)}\n[... output cut: 1 characters omitted ...]\n${"x".repeat(10_000)}`);
  });
});

describe("a noisy or dying server", () => {
  it("blank lines, log output, notifications and requests from the server are ignored; answers still match their calls", async () => {
    const connection = await connect({ fake: config("noisy") });
    expect(connection.status.fake).toEqual({ ok: true, toolCount: 6 });
    const echo = find(connection, "mcp__fake__echo");
    const answers = await Promise.all([echo.execute({ text: "a" }, context()), echo.execute({ text: "b" }, context())]);
    expect(answers.map((answer) => textOf(answer as never))).toEqual(["echo: a", "echo: b"]);
  });

  it("a server that exits during a call: the call fails with the exit code", async () => {
    const connection = await connect({ fake: config("die-on-call") });
    const result = await find(connection, "mcp__fake__echo").execute({ text: "a" }, context());
    expect(result).toEqual({ content: [{ type: "text", text: "MCP call failed: the server exited (code 7)" }], isError: true });
  });

  it("a server that exits at once: the reason names the exit code", async () => {
    const connection = await connect({ broken: config("exit-at-once") });
    expect(connection.status.broken?.error).toBe("the server exited (code 3)");
  });

  it("a call after close says the server is not running", async () => {
    const connection = await connect({ fake: config() });
    await connection.close();
    await new Promise((done) => setTimeout(done, 100));
    const result = await find(connection, "mcp__fake__echo").execute({ text: "x" }, context());
    expect(result).toEqual({ content: [{ type: "text", text: "MCP call failed: the server is not running" }], isError: true });
  });

  it("a command that cannot start: the reason says so", async () => {
    const connection = await connect({ missing: { command: "/no/such/program" } });
    expect(connection.status.missing?.error).toContain("could not start");
  });

  it("the timeout message names the method and the seconds", async () => {
    const connection = await connect({ quiet: config("silent") }, 1000);
    expect(connection.status.quiet?.error).toBe("no answer to initialize within 1 seconds");
  });
});

describe("declarations from unusual hints", () => {
  const declared = async () => (await connect({ fake: { ...config("hints"), env: { FAKE_VAR: "from-config" } } })).tools;
  const byName = async (name: string) => (await declared()).find((tool) => tool.name === `mcp__fake__${name}`)!;

  it("idempotent tools are safe to replay, but still need their own effect", async () => {
    expect(await byName("idem")).toMatchObject({ effect: "exec", replay: "safe" });
    expect(await byName("danger_idem")).toMatchObject({ effect: "irreversible", replay: "safe" });
  });
  it("read-only wins over destructive", async () => expect(await byName("both")).toMatchObject({ effect: "read", replay: "safe" }));
  it("a hint has to be the boolean true; the string 'true' does not count", async () => expect(await byName("stringly")).toMatchObject({ effect: "exec", replay: "never" }));
  it("the title stands in for a missing description, then the name", async () => {
    expect((await byName("titled")).description).toBe("A title");
    expect((await byName("bare")).description).toBe("bare");
  });
  it("a tool without a schema accepts an object with nothing in it", async () => expect((await byName("bare")).parameters).toEqual({ type: "object", properties: {} }));
  it("the server process gets the environment from the config", async () => {
    const result = await (await byName("env")).execute({}, context());
    expect(textOf(result as never)).toBe("from-config");
  });
  it("a paged listing keeps the order of the pages", async () => {
    const connection = await connect({ fake: config("paged") });
    expect(connection.tools.map((tool) => tool.name)).toEqual(["echo", "delete_all", "fetch", "plain", "big", "fail"].map((name) => `mcp__fake__${name}`));
  });
});
