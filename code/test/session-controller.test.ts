import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createController } from "../src/session-controller.ts";
import type { Controller, Surface } from "../src/session-controller.ts";
import { DEFAULT_SETTINGS } from "../src/config.ts";
import { createSessionStore } from "../src/session-store.ts";
import type { SessionMeta, SessionStore } from "../src/session-store.ts";
import { createTranscript } from "../src/transcript.ts";
import type { Block, Transcript } from "../src/transcript.ts";
import { scriptedClient } from "./support/scripted-client.ts";
import type { Script } from "./support/scripted-client.ts";
import { makeSandbox } from "./support/harness.ts";
import type { Sandbox } from "./support/harness.ts";

interface Rig {
  controller: Controller;
  transcript: Transcript;
  store: SessionStore;
  prefilled: string[];
  picks: SessionMeta[][];
  exited: boolean[];
  clears: number[];
  texts(): string[];
}

async function rig(sandbox: Sandbox, script: Script, options: { images?: string[]; autostart?: boolean; client?: ReturnType<typeof scriptedClient>; pick?: (list: SessionMeta[]) => SessionMeta | undefined; shell?: (command: string) => Promise<{ output: string; exitCode: number | null; timedOut: boolean }> } = {}): Promise<Rig> {
  const transcript = createTranscript();
  const store = createSessionStore(join(sandbox.directory, "sessions"));
  const prefilled: string[] = [];
  const picks: SessionMeta[][] = [];
  const exited: boolean[] = [];
  const clears: number[] = [];
  const surface: Surface = {
    changed: () => undefined,
    async pickSession(list) {
      picks.push(list);
      return options.pick?.(list);
    },
    clearScreen: () => void clears.push(1),
    prefill: (text) => void prefilled.push(text),
    exit: () => void exited.push(true),
  };
  const client = options.client ?? scriptedClient(script);
  const controller = createController({
    settings: { ...DEFAULT_SETTINGS, permissions: "full-access" },
    cwd: sandbox.directory,
    home: undefined,
    env: {},
    store,
    transcript,
    surface,
    clients: { agent: client },
    ...(options.images ? { images: options.images } : {}),
    ...(options.shell ? { runShell: options.shell } : {}),
  });
  if (options.autostart !== false) await controller.start();
  const texts = () =>
    transcript.blocks().map((block: Block) => (block.kind === "assistant" ? `A:${block.text}` : block.kind === "user" ? `U:${block.text}` : block.kind === "notice" ? `N:${block.text}` : block.kind === "info" ? `I:${block.markdown}` : block.kind));
  return { controller, transcript, store, prefilled, picks, exited, clears, texts };
}

describe("session controller", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await makeSandbox();
  });
  afterEach(() => sandbox.cleanup());

  it("runs a prompt, titles the session from it and remembers the context left", async () => {
    const r = await rig(sandbox, [{ text: "Hi there" }]);
    await r.controller.submit("say hi");
    assert.deepEqual(r.texts(), ["U:say hi", "A:Hi there"]);
    assert.equal(r.controller.currentMeta()?.title, "say hi");
    assert.ok((r.controller.statusInfo().contextLeftPercent ?? 0) > 90);
    await r.controller.close();
  });

  it("starts the agent in the launch directory without any restriction", async () => {
    const r = await rig(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "pwd; ls /etc | head -1" } }] }, { text: "ok" }]);
    await r.controller.submit("where am i");
    const tool = r.transcript.blocks().find((block) => block.kind === "tool");
    assert.ok(tool?.kind === "tool" && tool.status === "ok");
    const realDirectory = (await import("node:fs")).realpathSync(sandbox.directory);
    assert.ok(tool.output[0] === realDirectory || tool.output[0] === sandbox.directory, String(tool.output[0]));
    assert.ok(tool.output.length >= 2, "a path outside the directory could be listed");
    await r.controller.close();
  });

  it("answers unknown commands and refuses commands that cannot run during a run", async () => {
    const r = await rig(sandbox, [{ toolCalls: [{ name: "bash", args: { command: "sleep 0.4" } }] }, { text: "slow" }]);
    await r.controller.submit("/nope");
    assert.match(r.texts().at(-1)!, /Unknown command \/nope/);
    const running = r.controller.submit("go");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await r.controller.submit("/new");
    assert.match(r.texts().at(-1)!, /cannot be used while the agent is working/);
    await running;
    await r.controller.close();
  });

  it("steers a running agent with Enter and queues with Tab", async () => {
    const r = await rig(sandbox, (_request, index) => (index === 0 ? { toolCalls: [{ name: "bash", args: { command: "sleep 0.4" } }] } : index === 1 ? { text: "steered reply" } : { text: "queued reply" }));
    const running = r.controller.submit("start");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await r.controller.submit("change course", "steer");
    await r.controller.submit("and then this", "queue");
    assert.equal(r.controller.statusInfo().queued, 2);
    await running;
    const texts = r.texts();
    assert.ok(texts.includes("U:change course") && texts.includes("U:and then this"), texts.join("|"));
    assert.ok(texts.indexOf("A:steered reply") < texts.indexOf("A:queued reply"));
    assert.equal(r.controller.statusInfo().queued, 0);
    await r.controller.close();
  });

  it("cancels a run", async () => {
    const r = await rig(sandbox, [{ hang: true }]);
    const running = r.controller.submit("wait");
    await new Promise((resolve) => setTimeout(resolve, 60));
    r.controller.cancel();
    await running;
    assert.ok(r.texts().includes("N:Run cancelled."));
    assert.equal(r.controller.driver.working, false);
    await r.controller.close();
  });

  it("after a cancel the kernel's interrupted marker is kept for the model but not shown, and the next prompt works", async () => {
    const client = scriptedClient((_request, index) => (index === 0 ? { hang: true } : { text: "fresh answer" }));
    const r = await rig(sandbox, [], { client });
    const running = r.controller.submit("write a long essay");
    await new Promise((resolve) => setTimeout(resolve, 60));
    r.controller.cancel();
    await running;
    await r.controller.submit("what is 2+2");
    assert.ok(JSON.stringify(client.requests.at(-1)!.messages).includes("interrupted this request"));
    assert.ok(!r.texts().some((text) => text.includes("interrupted this request")), r.texts().join("|"));
    assert.ok(r.texts().includes("N:Run cancelled.") && r.texts().includes("A:fresh answer"));
    await r.controller.close();
  });

  it("/status reports the session, model, permissions and usage", async () => {
    const r = await rig(sandbox, [{ text: "hello" }]);
    await r.controller.submit("hi");
    await r.controller.submit("/status");
    const info = r.texts().at(-1)!;
    for (const part of ["I:", "scripted", "full-access", "not restricted", "1 replies"]) assert.ok(info.includes(part), part);
    await r.controller.close();
  });

  it("/compact reports when there is nothing to summarise", async () => {
    const r = await rig(sandbox, []);
    await r.controller.submit("/compact");
    assert.ok(r.texts().some((text) => text.startsWith("N:Nothing worth summarising")));
    await r.controller.close();
  });

  it("/compact summarises a conversation", async () => {
    const r = await rig(sandbox, (request, index) => (request.system.includes("summar") || JSON.stringify(request.messages).includes("<conversation>") ? { text: "SUMMARY" } : { text: `reply ${index}` }));
    await r.controller.submit("first question");
    await r.controller.submit("second question");
    await r.controller.submit("/compact");
    assert.ok(r.transcript.blocks().some((block) => block.kind === "compaction"), r.texts().join("|"));
    await r.controller.close();
  });

  const summarising = (request: { system: string; messages: unknown }, index: number) => (request.system.includes("summar") || JSON.stringify(request.messages).includes("<conversation>") ? { text: "SUMMARY" } : { text: `reply ${index}` });

  it("compactIdle leaves a small context alone", async () => {
    const r = await rig(sandbox, summarising);
    await r.controller.submit("hello");
    assert.equal(await r.controller.compactIdle(20_000, 5), false);
    assert.ok(!r.transcript.blocks().some((block) => block.kind === "compaction"));
    await r.controller.close();
  });

  it("compactIdle compacts a large context and says so in one dim line instead of the compaction block", async () => {
    const r = await rig(sandbox, summarising);
    await r.controller.submit(`first ${"word ".repeat(3000)}`);
    await r.controller.submit(`second ${"word ".repeat(3000)}`);
    assert.equal(await r.controller.compactIdle(1000, 5), true);
    assert.ok(!r.transcript.blocks().some((block) => block.kind === "compaction"), "no separate compaction block");
    assert.ok(r.texts().some((text) => /^N:compacted after 5 min idle, \d+k? to \d+k? tokens$/.test(text)), r.texts().join("|"));
    await r.controller.close();
  });

  it("compactIdle does not run while a run is going", async () => {
    const r = await rig(sandbox, [{ hang: true }]);
    const running = r.controller.submit("long thing");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await r.controller.compactIdle(1000, 5), false);
    r.controller.cancel();
    await running;
    await r.controller.close();
  });

  it("/new starts another session and discards an empty one", async () => {
    const r = await rig(sandbox, [{ text: "a" }]);
    const first = r.controller.currentMeta()!;
    await r.controller.submit("/new");
    assert.equal(await r.store.get(first.id), undefined, "the empty first session is removed");
    await r.controller.submit("hello");
    const second = r.controller.currentMeta()!;
    await r.controller.submit("/new");
    assert.notEqual(r.controller.currentMeta()?.id, second.id);
    assert.ok(await r.store.get(second.id), "a session with a prompt is kept");
    await r.controller.close();
  });

  it("/resume continues an earlier session and shows what was said", async () => {
    const r = await rig(sandbox, [{ text: "one" }, { text: "two" }]);
    await r.controller.submit("first topic");
    const earlier = r.controller.currentMeta()!;
    await r.controller.submit("/new");
    await r.controller.submit("second topic");
    await r.controller.submit(`/resume ${earlier.id.slice(0, 8)}`);
    assert.equal(r.controller.currentMeta()?.id, earlier.id);
    assert.ok(r.texts().includes("U:first topic"), r.texts().join("|"));
    assert.ok(r.texts().some((text) => text.startsWith("N:Resumed first topic")));
    await r.controller.close();
  });

  it("/resume without an argument lets the surface pick", async () => {
    let chosen: SessionMeta | undefined;
    const r = await rig(sandbox, [{ text: "one" }], { pick: (list) => (chosen = list[0]) });
    await r.controller.submit("topic a");
    const a = r.controller.currentMeta()!;
    await r.controller.submit("/new");
    await r.controller.submit("/resume");
    assert.equal(r.picks.length, 1);
    assert.equal(chosen?.id, a.id);
    assert.equal(r.controller.currentMeta()?.id, a.id);
    await r.controller.close();
  });

  it("/fork copies the conversation into a new session and leaves the original alone", async () => {
    const r = await rig(sandbox, [{ text: "one" }, { text: "two" }]);
    await r.controller.submit("topic");
    const original = r.controller.currentMeta()!;
    await r.controller.submit("/fork");
    const child = r.controller.currentMeta()!;
    assert.notEqual(child.id, original.id);
    assert.equal(child.parentId, original.id);
    assert.equal(child.title, "fork: topic");
    await r.controller.submit("only in the fork");
    await r.controller.close();
    const entries = await (await import("node:fs/promises")).readFile(r.store.sessionFile(original.id), "utf8");
    assert.ok(!entries.includes("only in the fork"));
  });

  it("/undo goes back to before the last message and puts it in the prompt", async () => {
    const r = await rig(sandbox, [{ text: "one" }, { text: "two" }, { text: "three" }]);
    await r.controller.submit("keep this");
    await r.controller.submit("take this back");
    await r.controller.submit("/undo");
    assert.deepEqual(r.prefilled, ["take this back"]);
    const messages = JSON.stringify(await r.controller.current()!.agent.log.project());
    assert.ok(messages.includes("keep this") && !messages.includes("take this back"));
    await r.controller.close();
  });

  /** A model that works on the goal once and then reports the goal check as done. */
  const goalScript = (seen: string[] = []) => (request: { messages: Array<{ role: string; content: unknown }> }) => {
    const last = JSON.stringify(request.messages.filter((message) => message.role === "user").at(-1)?.content);
    if (last.includes("You are about to stop")) return { text: "- [done] ship the feature :: shipped" };
    seen.push(last);
    return { text: "on it" };
  };

  it("/goal starts a run with the objective as the prompt", async () => {
    const seen: string[] = [];
    const r = await rig(sandbox, goalScript(seen));
    await r.controller.submit("/goal ship the feature");
    assert.ok(seen.length > 0, "the model was asked without any further message");
    assert.match(seen[0]!, /ship the feature/);
    assert.ok(r.transcript.blocks().some((block) => block.kind === "user" && block.text === "ship the feature"));
    assert.ok(r.transcript.blocks().some((block) => block.kind === "assistant" && block.text.includes("on it")));
    await r.controller.close();
  });

  it("/goal shows the goal (done after the run) and /goal clear ends it", async () => {
    const r = await rig(sandbox, goalScript());
    await r.controller.submit("/goal ship the feature");
    assert.equal((await r.controller.current()!.agent.goal())?.objective, "ship the feature");
    await r.controller.submit("/goal");
    assert.match(r.texts().at(-1)!, /Goal \(complete\): ship the feature/);
    await r.controller.submit("/goal clear");
    assert.equal((await r.controller.current()!.agent.goal())?.status, "complete");
    await r.controller.close();
  });

  it("/model, /permissions and /redaction reopen the session and keep the conversation", async () => {
    const r = await rig(sandbox, [{ text: "one" }, { text: "two" }]);
    await r.controller.submit("hello");
    await r.controller.submit("/redaction on");
    assert.equal(r.controller.statusInfo().redaction, true);
    await r.controller.submit("/permissions read-only");
    assert.equal(r.controller.statusInfo().permissions, "read-only");
    await r.controller.submit("/permissions bogus");
    assert.match(r.texts().at(-1)!, /Unknown preset "bogus"/);
    await r.controller.submit("/model deepseek");
    assert.equal(r.controller.statusInfo().provider, "deepseek");
    await r.controller.submit("again");
    assert.ok(r.texts().includes("U:hello") && r.texts().includes("U:again"));
    const messages = JSON.stringify(await r.controller.current()!.agent.log.project());
    assert.ok(messages.includes("hello") && messages.includes("again"));
    await r.controller.close();
  });

  it("!command runs a shell command for the user and shows the real exit code", async () => {
    const r = await rig(sandbox, [], { shell: async (command) => ({ output: `ran ${command}\n`, exitCode: 4, timedOut: false }) });
    await r.controller.submit("!make test");
    const block = r.transcript.blocks().at(-1)!;
    assert.deepEqual(block, { kind: "shell", command: "make test", output: ["ran make test"], hidden: 0, exitCode: 4 });
    await r.controller.close();
  });

  it("an @image in the prompt and --image files are attached to the message as images", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(sandbox.directory, "shot.png"), "not really a png");
    await writeFile(join(sandbox.directory, "first.jpg"), "not really a jpg");
    const client = scriptedClient([{ text: "red" }, { text: "again" }]);
    const r = await rig(sandbox, [], { client, images: [join(sandbox.directory, "first.jpg")] });
    await r.controller.submit("what is in @shot.png ?");
    const first = client.requests[0]!.messages.find((message) => message.role === "user")!;
    assert.deepEqual(first.content.filter((part) => part.type === "image").map((part) => (part.type === "image" ? [part.mediaType, part.ref.split("/").pop()] : [])), [["image/jpeg", "first.jpg"], ["image/png", "shot.png"]]);
    assert.ok(r.texts().some((text) => text.startsWith("U:what is in @shot.png ?") && text.includes("[image: shot.png]") && text.includes("[image: first.jpg]")), r.texts().join("|"));
    await r.controller.submit("and a plain follow-up");
    const second = client.requests[1]!.messages.filter((message) => message.role === "user").at(-1)!;
    assert.equal(second.content.some((part) => part.type === "image"), false, "--image applies to the first prompt only");
    await r.controller.close();
  });

  it("going to read-only and back gives the agent all four tools again", async () => {
    const client = scriptedClient([{ text: "a" }, { text: "b" }]);
    const r = await rig(sandbox, [], { client });
    await r.controller.submit("/permissions read-only");
    await r.controller.submit("one");
    await r.controller.submit("/permissions full-access");
    await r.controller.submit("two");
    const toolNames = (index: number) => client.requests[index]!.tools.map((tool) => tool.name).sort().join();
    assert.equal(toolNames(0), "read");
    assert.equal(toolNames(1), "bash,edit,read,write");
    await r.controller.close();
  });

  it("/rename sets the title shown in the session list", async () => {
    const r = await rig(sandbox, []);
    await r.controller.submit("/rename Parser work");
    assert.equal(r.controller.currentMeta()?.title, "Parser work");
    await r.controller.close();
  });

  it("/diff shows tracked changes and untracked files", async () => {
    const { execSync } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    execSync("git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: sandbox.directory });
    await writeFile(join(sandbox.directory, "new.txt"), "brand new\n");
    const r = await rig(sandbox, []);
    await r.controller.submit("/diff");
    assert.match(r.texts().at(-1)!, /\+brand new/);
    await r.controller.close();
  });

  it("/exit asks the surface to leave; /diff and /mcp work", async () => {
    const r = await rig(sandbox, [], { shell: async () => ({ output: "diff --git a b\n", exitCode: 0, timedOut: false }) });
    await r.controller.submit("/diff");
    assert.match(r.texts().at(-1)!, /````diff/);
    await r.controller.submit("/mcp");
    assert.match(r.texts().at(-1)!, /No MCP servers/);
    await r.controller.submit("/exit");
    assert.deepEqual(r.exited, [true]);
    await r.controller.close();
  });

  it("resumes with start({resume}) and fails clearly for an unknown session", async () => {
    const r = await rig(sandbox, [{ text: "one" }]);
    await r.controller.submit("topic");
    const id = r.controller.currentMeta()!.id;
    await r.controller.close();
    const again = await rig(sandbox, [{ text: "two" }], { autostart: false });
    await assert.rejects(() => again.controller.start({ resume: "nonexistent" }), /No session matches/);
    await again.controller.start({ resume: "last" });
    assert.equal(again.controller.currentMeta()?.id, id);
    assert.ok(again.texts().includes("U:topic"));
    await again.controller.close();
  });
});
