import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Content, Tool, ToolResult } from "@sakura/kernel";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServerStatus {
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface McpConnection {
  /** Every tool of every server that connected, named `mcp__<server>__<tool>`. */
  tools: Tool[];
  /** One entry per server, for the person running the agent (the model is not told). */
  status: Record<string, McpServerStatus>;
  /** Stops the server processes. */
  close(): Promise<void>;
}

interface Rpc {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_TEXT_BYTES = 20_000;

/** A JSON-RPC 2.0 client over a child process that speaks one JSON message per line. */
function openRpc(config: McpServerConfig): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let nextId = 0;
    let buffer = "";
    let ended = false;

    const failAll = (reason: string) => {
      ended = true;
      for (const [id, entry] of waiting) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
        waiting.delete(id);
      }
    };
    child.on("error", (error) => {
      failAll(`could not start: ${error.message}`);
      reject(error);
    });
    child.on("exit", (code) => failAll(`the server exited (code ${code})`));
    child.stderr.on("data", () => undefined); // servers log here; not our business
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = typeof message.id === "number" ? waiting.get(message.id) : undefined;
        if (!entry || ("method" in message && message.method)) continue; // requests and notifications from the server are ignored
        waiting.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(String(message.error.message ?? "request failed")));
        else entry.resolve(message.result);
      }
    });

    const send = (message: unknown) => {
      if (!ended && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    resolve({
      request: (method, params, timeoutMs = 60_000) =>
        new Promise((done, fail) => {
          if (ended) return fail(new Error("the server is not running"));
          const id = ++nextId;
          const timer = setTimeout(() => {
            waiting.delete(id);
            fail(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)} seconds`));
          }, timeoutMs);
          waiting.set(id, { resolve: done, reject: fail, timer });
          send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
        }),
      notify: (method, params) => send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }),
      close: () => {
        ended = true;
        child.kill();
      },
    });
  });
}

function cut(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TEXT_BYTES) return value;
  const half = MAX_TEXT_BYTES / 2;
  return `${value.slice(0, half)}\n[... output cut: ${value.length - MAX_TEXT_BYTES} characters omitted ...]\n${value.slice(-half)}`;
}

function toContent(parts: unknown): Content[] {
  if (!Array.isArray(parts)) return [{ type: "text", text: "(no content)" }];
  const content: Content[] = [];
  for (const part of parts as Array<Record<string, any>>) {
    if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: cut(part.text) });
    else content.push({ type: "text", text: `[${String(part.type)} content not shown]` });
  }
  return content.length > 0 ? content : [{ type: "text", text: "(no output)" }];
}

function describeTool(serverName: string, rpc: Rpc, definition: any): Tool {
  const hints = definition.annotations ?? {};
  const readOnly = hints.readOnlyHint === true;
  return {
    name: `mcp__${serverName}__${definition.name}`,
    description: String(definition.description ?? definition.title ?? definition.name),
    parameters: definition.inputSchema ?? { type: "object", properties: {} },
    effect: readOnly ? "read" : hints.destructiveHint === true ? "irreversible" : hints.openWorldHint === true ? "network" : "exec",
    replay: readOnly || hints.idempotentHint === true ? "safe" : "never",
    async execute(args, { signal }): Promise<ToolResult> {
      const onAbort = () => rpc.notify("notifications/cancelled", { reason: "the run was cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await rpc.request("tools/call", { name: definition.name, arguments: args ?? {} });
        return { content: toContent(result?.content), ...(result?.isError ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: "text", text: `MCP call failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function connectOne(name: string, config: McpServerConfig, timeoutMs: number): Promise<{ rpc: Rpc; tools: Tool[] }> {
  const rpc = await openRpc(config);
  try {
    await rpc.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "sakura", version: "0.0.0" } }, timeoutMs);
    rpc.notify("notifications/initialized");
    const definitions: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      definitions.push(...(page?.tools ?? []));
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);
    return { rpc, tools: definitions.map((definition) => describeTool(name, rpc, definition)) };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

/**
 * Starts the servers at the same time and asks each for its tools, once. A server that fails (does not start, does not answer
 * within `timeoutMs`, default 10 seconds) is reported in `status` and its tools are left out; the rest work as usual.
 */
export async function connectMcp(servers: Record<string, McpServerConfig>, options: { timeoutMs?: number } = {}): Promise<McpConnection> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const rpcs: Rpc[] = [];
  const tools: Tool[] = [];
  const status: Record<string, McpServerStatus> = {};
  await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      try {
        const connected = await connectOne(name, config, timeoutMs);
        rpcs.push(connected.rpc);
        tools.push(...connected.tools);
        status[name] = { ok: true, toolCount: connected.tools.length };
      } catch (error) {
        status[name] = { ok: false, toolCount: 0, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  // keep the order of the configuration, not of the answers
  const order = Object.keys(servers);
  tools.sort((left, right) => order.findIndex((name) => left.name.startsWith(`mcp__${name}__`)) - order.findIndex((name) => right.name.startsWith(`mcp__${name}__`)));
  return {
    tools,
    status,
    close: async () => {
      for (const rpc of rpcs) rpc.close();
    },
  };
}
