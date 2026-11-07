// A tiny MCP server over stdio for the tests. Behaviour is chosen by the first argument.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal";
// Modes: normal; paged; silent (never answers); exit-at-once; record (writes every received line to $FAKE_MCP_LOG);
// hang-call (answers everything but tools/call); die-on-call (exits with 7 on a call); noisy (adds blank lines, stderr, server notifications and
// a server request that reuses the id of the pending request); shapes (odd tool results); hints (tools with unusual hints and descriptions).
const normalTools = [
  { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "delete_all", description: "Delete everything", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "fetch", description: "Fetch a web page", inputSchema: { type: "object" }, annotations: { openWorldHint: true } },
  { name: "plain", description: "No hints", inputSchema: { type: "object" } },
  { name: "big", description: "Long output", inputSchema: { type: "object" } },
  { name: "fail", description: "Always fails", inputSchema: { type: "object" } },
];
const hintTools = [
  { name: "idem", description: "idempotent", inputSchema: { type: "object" }, annotations: { idempotentHint: true } },
  { name: "both", description: "read and destructive", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: "danger_idem", description: "destructive but idempotent", inputSchema: { type: "object" }, annotations: { destructiveHint: true, idempotentHint: true } },
  { name: "stringly", description: "hint given as a string", inputSchema: { type: "object" }, annotations: { readOnlyHint: "true", destructiveHint: "true", openWorldHint: "true", idempotentHint: "true" } },
  { name: "titled", title: "A title" },
  { name: "bare" },
  { name: "env", description: "reads FAKE_VAR", inputSchema: { type: "object" } },
];
const shapeTools = ["no_result", "no_content", "empty", "weird", "number_text", "bare_error", "slow_n"].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
const manyTools = Array.from({ length: 12 }, (_, index) => ({ name: `tool_${index}`, description: `Tool number ${index}`, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }));
const tools = mode === "many" ? manyTools : mode === "ten" ? manyTools.slice(0, 10) : mode === "hints" ? hintTools : mode === "shapes" ? shapeTools : normalTools;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
if (mode === "exit-at-once") process.exit(3);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (mode === "record") appendFileSync(process.env.FAKE_MCP_LOG, `${line}\n`);
  const message = JSON.parse(line);
  if (mode === "silent") return;
  if (mode === "noisy") {
    process.stdout.write("\n   \n");
    process.stderr.write("some log line\n");
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, method: "ping" });
  }
  if (mode === "hang-call" && message.method === "tools/call") return;
  if (mode === "die-on-call" && message.method === "tools/call") process.exit(7);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  if (message.method === "tools/list") {
    if (mode === "paged") {
      return message.params?.cursor
        ? send({ jsonrpc: "2.0", id: message.id, result: { tools: tools.slice(3) } })
        : send({ jsonrpc: "2.0", id: message.id, result: { tools: tools.slice(0, 3), nextCursor: "next" } });
    }
    return send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  }
  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (mode === "shapes") {
      const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
      if (name === "no_result") return send({ jsonrpc: "2.0", id: message.id, result: null });
      if (name === "no_content") return reply({});
      if (name === "empty") return reply({ content: [] });
      if (name === "weird") return reply({ content: [{ type: "resource", uri: "x" }, { type: "text", text: "kept" }, {}] });
      if (name === "number_text") return reply({ content: [{ type: "text", text: 5 }] });
      if (name === "bare_error") return send({ jsonrpc: "2.0", id: message.id, error: { code: 1 } });
      if (name === "slow_n") return reply({ content: [{ type: "text", text: "x".repeat(args.n) }] });
    }
    if (name === "env") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(process.env.FAKE_VAR) }] } });
    if (name === "echo") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo: ${args.text}` }] } });
    if (name === "big") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "x".repeat(60000) }] } });
    if (name === "fail") return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
    if (name === "plain") return send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "protocol failure" } });
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "ok" }] } });
  }
});
