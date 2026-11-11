import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientMcpServers, serverName } from "../../src/acp/mcp.ts";

describe("client MCP servers (L1)", () => {
  it("turns a stdio server into the framework's definition, with env as a record", () => {
    const { servers, skipped } = clientMcpServers([{ name: "files", command: "/usr/bin/mcp-files", args: ["--root", "/w"], env: [{ name: "TOKEN", value: "abc" }] }]);
    assert.deepEqual(servers, { files: { command: "/usr/bin/mcp-files", args: ["--root", "/w"], env: { TOKEN: "abc" } } });
    assert.equal(skipped, 0);
  });

  it("leaves out HTTP and SSE servers and entries without a name or command, and counts them", () => {
    const { servers, skipped } = clientMcpServers([
      { type: "http", name: "remote", url: "https://x", headers: [{ name: "Authorization", value: "Bearer s" }] },
      { type: "sse", name: "old", url: "https://y" },
      { name: "", command: "x" },
      { name: "nocommand" },
      { name: "ok", command: "run", type: "stdio" },
      5,
      null,
    ]);
    assert.deepEqual(Object.keys(servers), ["ok"]);
    assert.equal(skipped, 6);
  });

  it("makes names usable in tool names and unique", () => {
    assert.equal(serverName("My Server!"), "My-Server");
    assert.deepEqual(Object.keys(clientMcpServers([{ name: "a b", command: "x" }, { name: "a-b", command: "y" }, { name: "a/b", command: "z" }]).servers), ["a-b", "a-b-2", "a-b-3"]);
  });

  it("anything that is not a list gives no servers", () => {
    for (const junk of [undefined, null, "x", 5, {}]) assert.deepEqual(clientMcpServers(junk), { servers: {}, skipped: 0 });
  });
});
