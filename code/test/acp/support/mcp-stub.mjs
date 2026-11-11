// A minimal stdio MCP server for tests: it writes the file named by MARKER_FILE when it is initialised (saying how long SECRET_TOKEN
// is, never what it is) and offers one tool, `ping`.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || !message.method) return;
  if (message.method === "initialize") {
    if (process.env.MARKER_FILE) writeFileSync(process.env.MARKER_FILE, `initialized with a token of ${(process.env.SECRET_TOKEN ?? "").length} characters\n`);
    reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0.0.0" } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: {} } }] });
  } else if (message.method === "tools/call") {
    reply(message.id, { content: [{ type: "text", text: "pong" }] });
  } else reply(message.id, {});
});
