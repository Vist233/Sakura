import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runTui } from "../../src/tui/app.ts";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import { createSessionStore } from "../../src/session-store.ts";
import { makeSandbox } from "../support/harness.ts";
import type { Sandbox } from "../support/harness.ts";
import { scriptedClient } from "../support/scripted-client.ts";
import type { Script } from "../support/scripted-client.ts";
import { VirtualTerminal } from "../support/vt.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(sandbox: Sandbox, script: Script, start: { resume?: string } = {}, columns = 80) {
  const terminal = new VirtualTerminal(columns);
  const stdin = new PassThrough();
  const stdout = Object.assign({ columns, write: (data: string) => terminal.write(data) });
  const store = createSessionStore(join(sandbox.directory, "sessions"));
  const running = runTui({
    controller: { settings: { ...DEFAULT_SETTINGS, permissions: "full-access" }, cwd: sandbox.directory, home: undefined, env: {}, store, clients: { agent: scriptedClient(script) } },
    start,
    stdin,
    stdout,
    color: false,
    version: "9.9.9",
  });
  const send = async (text: string, wait = 60) => {
    stdin.write(text);
    await sleep(wait);
  };
  const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out; screen:\n${terminal.text()}`);
      await sleep(20);
    }
  };
  return { terminal, send, waitFor, running, store };
}

describe("tui", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  it("shows the banner, takes a prompt, renders the Markdown reply and leaves with Ctrl-C twice", async () => {
    const app = launch(sandbox, [{ text: "# Result\n\nThere are **two** items:\n\n- one\n- two" }]);
    await app.waitFor(() => app.terminal.text().includes("Sakura Terminal"));
    assert.match(app.terminal.text(), /v9\.9\.9/);
    await app.send("list things\r");
    await app.waitFor(() => app.terminal.text().includes("• two"));
    const screen = app.terminal.text();
    assert.match(screen, /› list things/);
    assert.match(screen, /• Result/);
    assert.match(screen, /There are two items:/);
    assert.ok(!screen.includes("**"), "Markdown markers are rendered, not shown");
    assert.match(screen, /context left/);
    await app.send("\u0003");
    assert.match(app.terminal.text(), /Press Ctrl-C again to leave/);
    await app.send("\u0003");
    assert.equal(await app.running, 0);
    assert.match(app.terminal.text(), /Resume it with: sakura-terminal resume/);
  });

  it("shows a slash popup and completes with Tab", async () => {
    const app = launch(sandbox, []);
    await app.waitFor(() => app.terminal.text().includes("Sakura Terminal"));
    await app.send("/com");
    assert.match(app.terminal.text(), /\/compact/);
    await app.send("\t");
    assert.match(app.terminal.text(), /› \/compact/);
    await app.send("\u0003\u0003");
    await app.send("\u0003");
    await app.running;
  });

  it("Esc cancels a working agent", async () => {
    const app = launch(sandbox, [{ hang: true }]);
    await app.waitFor(() => app.terminal.text().includes("Sakura Terminal"));
    await app.send("do a long thing\r");
    await app.waitFor(() => app.terminal.text().includes("Working ("));
    await app.send("\u001b");
    await app.waitFor(() => app.terminal.text().includes("Run cancelled."));
    assert.ok(!app.terminal.text().includes("Working ("));
    await app.send("\u0003\u0003");
    await app.send("\u0003");
    await app.running;
  });

  it("a line typed during a run is shown as steering, then delivered", async () => {
    const app = launch(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "bash", args: { command: "sleep 0.5" } }] } : { text: "adjusted" }));
    await app.waitFor(() => app.terminal.text().includes("Sakura Terminal"));
    await app.send("begin\r");
    await app.waitFor(() => app.terminal.text().includes("Working ("));
    await app.send("please change course\r", 120);
    assert.match(app.terminal.text(), /↳ steering: please change course/);
    await app.waitFor(() => app.terminal.text().includes("• adjusted"));
    assert.match(app.terminal.text(), /› please change course/);
    await app.send("\u0003\u0003");
    await app.send("\u0003");
    await app.running;
  });

  it("/status prints a table of facts", async () => {
    const app = launch(sandbox, []);
    await app.waitFor(() => app.terminal.text().includes("Sakura Terminal"));
    await app.send("/status\r", 200);
    await app.waitFor(() => app.terminal.text().includes("Permissions"));
    assert.match(app.terminal.text(), /not restricted/);
    await app.send("\u0003\u0003");
    await app.send("\u0003");
    await app.running;
  });

  it("resumes an earlier session through the picker", async () => {
    const first = launch(sandbox, [{ text: "first answer" }]);
    await first.waitFor(() => first.terminal.text().includes("Sakura Terminal"));
    await first.send("remember the topic\r");
    await first.waitFor(() => first.terminal.text().includes("first answer"));
    await first.send("\u0004");
    await first.running;

    const second = launch(sandbox, []);
    await second.waitFor(() => second.terminal.text().includes("Sakura Terminal"));
    await second.send("/resume\r", 200);
    await second.waitFor(() => second.terminal.text().includes("Resume a session"));
    assert.match(second.terminal.text(), /remember the topic/);
    await second.send("\r", 200);
    await second.waitFor(() => second.terminal.text().includes("Resumed remember the topic"));
    assert.match(second.terminal.text(), /• first answer/);
    await second.send("\u0004");
    await second.running;
  });

  it("keeps the layout at a narrow width", async () => {
    const app = launch(sandbox, [{ text: "A reasonably long line of text that has to wrap in a small terminal window." }], {}, 36);
    await app.waitFor(() => app.terminal.text().includes("Sakura Terminal"));
    await app.send("hi\r");
    await app.waitFor(() => app.terminal.text().includes("window."));
    for (const line of app.terminal.lines()) assert.ok(line.length <= 40, line);
    await app.send("\u0004");
    await app.running;
  });
});
