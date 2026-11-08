import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEnvironment } from "@sakura/env";
import { createKernel } from "@sakura/kernel";
import type { Environment, Message } from "@sakura/kernel";
import { createMemoryLog } from "@sakura/session";
import { createFauxClient, createRng } from "@sakura/testing";
import { contextPlugin } from "../src/index.ts";

let dir: string;
let env: Environment;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "context-"));
  env = createLocalEnvironment(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

async function run(plugin: ReturnType<typeof contextPlugin>, log = createMemoryLog(), input = "hi") {
  const llm = createFauxClient([{ text: "ok" }, { text: "ok" }, { text: "ok" }]);
  const kernel = createKernel({ llm, env, system: "s", plugins: [plugin], compaction: false });
  const handle = kernel.run(log, input);
  for await (const _event of handle.events) void _event;
  await handle.result;
  return { llm, log };
}

describe("AGENTS.md in the working directory", () => {
  for (const seed of range(30)) {
    it(`is pinned at the start of the conversation (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const body = `Rule ${rng.int(0, 99999)}: always run the tests.\n${"more ".repeat(rng.int(0, 30))}`;
      await writeFile(join(dir, "AGENTS.md"), body);
      const { llm, log } = await run(contextPlugin());
      const first = llm.requests[0]!.messages[0]!;
      expect(first.role).toBe("user");
      expect(textOf(first)).toContain(body.trim());
      expect(textOf(first)).toContain(join(dir, "AGENTS.md"));
      const pinned = (await log.branch()).filter((entry) => entry.type === "custom_message");
      expect(pinned).toHaveLength(1);
      expect(pinned[0]).toMatchObject({ pinned: true, customType: "agents_md" });
    });
  }

  it("does nothing when there is no file", async () => {
    const { log } = await run(contextPlugin());
    expect((await log.branch()).some((entry) => entry.type === "custom_message")).toBe(false);
  });
  for (const content of ["", "   \n\n  "]) {
    it(`ignores an empty file (${JSON.stringify(content)})`, async () => {
      await writeFile(join(dir, "AGENTS.md"), content);
      const { log } = await run(contextPlugin());
      expect((await log.branch()).some((entry) => entry.type === "custom_message")).toBe(false);
    });
  }
  it("can be turned off", async () => {
    await writeFile(join(dir, "AGENTS.md"), "rules");
    const { log } = await run(contextPlugin({ cwd: false }));
    expect((await log.branch()).some((entry) => entry.type === "custom_message")).toBe(false);
  });
  it("only reads the file name AGENTS.md", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "not me");
    await writeFile(join(dir, "agents.md.bak"), "not me either");
    const { log } = await run(contextPlugin());
    expect((await log.branch()).some((entry) => entry.type === "custom_message")).toBe(false);
  });
  it("does not look in parent directories or subdirectories", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "AGENTS.md"), "sub rules");
    const subEnv = createLocalEnvironment(join(dir, "sub", "deeper"));
    await mkdir(join(dir, "sub", "deeper"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "parent rules");
    const kernel = createKernel({ llm: createFauxClient([{ text: "ok" }]), env: subEnv, system: "s", plugins: [contextPlugin()], compaction: false });
    const log = createMemoryLog();
    const handle = kernel.run(log, "hi");
    for await (const _event of handle.events) void _event;
    expect((await log.branch()).some((entry) => entry.type === "custom_message")).toBe(false);
  });
  it("does not follow @path includes", async () => {
    await writeFile(join(dir, "other.md"), "SECRET INCLUDE");
    await writeFile(join(dir, "AGENTS.md"), "see @other.md");
    const { llm } = await run(contextPlugin());
    expect(textOf(llm.requests[0]!.messages[0]!)).not.toContain("SECRET INCLUDE");
  });
});

describe("a custom file name and size limit", () => {
  it("reads the configured name", async () => {
    await writeFile(join(dir, "RULES.md"), "custom name");
    const { llm } = await run(contextPlugin({ fileName: "RULES.md" }));
    expect(textOf(llm.requests[0]!.messages[0]!)).toContain("custom name");
  });
  for (const limit of [10, 50, 200, 1000]) {
    it(`cuts a long file at ${limit} bytes and says so`, async () => {
      await writeFile(join(dir, "AGENTS.md"), "x".repeat(limit * 3));
      const { llm } = await run(contextPlugin({ maxBytes: limit }));
      const text = textOf(llm.requests[0]!.messages[0]!);
      expect(text).toContain(`The file was cut after ${limit} bytes`);
      expect(text.match(/x{5,}/g)?.[0]?.length).toBe(limit);
    });
  }
});

describe("two sources: user-level and project", () => {
  it("puts the user-level file first, then the project file", async () => {
    await writeFile(join(dir, "user.md"), "USER RULES");
    await writeFile(join(dir, "AGENTS.md"), "PROJECT RULES");
    const { llm } = await run(contextPlugin({ userFile: join(dir, "user.md") }));
    const text = textOf(llm.requests[0]!.messages[0]!);
    expect(text.indexOf("USER RULES")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("USER RULES")).toBeLessThan(text.indexOf("PROJECT RULES"));
  });
  it("works with only the user-level file", async () => {
    await writeFile(join(dir, "user.md"), "USER ONLY");
    const { llm } = await run(contextPlugin({ userFile: join(dir, "user.md") }));
    expect(textOf(llm.requests[0]!.messages[0]!)).toContain("USER ONLY");
  });
  it("skips a user-level path that does not exist", async () => {
    await writeFile(join(dir, "AGENTS.md"), "PROJECT");
    const { llm } = await run(contextPlugin({ userFile: join(dir, "missing.md") }));
    expect(textOf(llm.requests[0]!.messages[0]!)).toContain("PROJECT");
  });
});

describe("once per conversation", () => {
  for (const runs of range(6)) {
    it(`is not added again on run ${runs}`, async () => {
      await writeFile(join(dir, "AGENTS.md"), "rules");
      const plugin = contextPlugin();
      const log = createMemoryLog();
      for (let index = 0; index < runs; index++) await run(plugin, log, `q${index}`);
      expect((await log.branch()).filter((entry) => entry.type === "custom_message")).toHaveLength(1);
    });
  }
  it("a changed file is not picked up by itself", async () => {
    await writeFile(join(dir, "AGENTS.md"), "version one");
    const plugin = contextPlugin();
    const log = createMemoryLog();
    await run(plugin, log, "a");
    await writeFile(join(dir, "AGENTS.md"), "version two");
    const { llm } = await run(plugin, log, "b");
    expect(textOf(llm.requests[0]!.messages[0]!)).toContain("version one");
  });
  it("stays in front after compaction", async () => {
    await writeFile(join(dir, "AGENTS.md"), "KEEP ME");
    const llm = createFauxClient((request) => ({ text: textOf(request.messages.at(-1)!).startsWith("You are writing") ? "SUMMARY" : "r".repeat(500) }), { contextWindow: 1000 });
    const kernel = createKernel({ llm, env, system: "s", plugins: [contextPlugin()], compaction: { reserveTokens: 200, keepRecentTokens: 150 } });
    const log = createMemoryLog();
    for (let turn = 0; turn < 8; turn++) {
      const handle = kernel.run(log, `${turn} ${"u".repeat(400)}`);
      for await (const _event of handle.events) void _event;
    }
    expect((await log.branch()).some((entry) => entry.type === "compaction")).toBe(true);
    expect(textOf(llm.requests.filter((request) => !textOf(request.messages.at(-1)!).startsWith("You are writing")).at(-1)!.messages[0]!)).toContain("KEEP ME");
  });
});

describe("reload", () => {
  it("adds a replacing message only when the files changed", async () => {
    await writeFile(join(dir, "AGENTS.md"), "version one");
    const plugin = contextPlugin();
    const log = createMemoryLog();
    await run(plugin, log, "a");
    expect(await plugin.reload({ log, env })).toBe(false);
    await writeFile(join(dir, "AGENTS.md"), "version two");
    expect(await plugin.reload({ log, env })).toBe(true);
    expect(await plugin.reload({ log, env })).toBe(false);
    const { llm } = await run(plugin, log, "b");
    const pinned = llm.requests[0]!.messages.filter((message) => textOf(message).includes("Instructions from"));
    expect(pinned).toHaveLength(2);
    expect(textOf(pinned[1]!)).toContain("replace all earlier project instructions");
    expect(textOf(pinned[1]!)).toContain("version two");
  });
  it("does nothing when the file disappeared", async () => {
    await writeFile(join(dir, "AGENTS.md"), "rules");
    const plugin = contextPlugin();
    const log = createMemoryLog();
    await run(plugin, log, "a");
    await rm(join(dir, "AGENTS.md"));
    expect(await plugin.reload({ log, env })).toBe(false);
  });
});

describe("refreshing after a compaction", () => {
  async function converse(plugin: ReturnType<typeof contextPlugin>, log: ReturnType<typeof createMemoryLog>, turns: number, between?: (turn: number) => Promise<void>) {
    const llm = createFauxClient((request) => ({ text: textOf(request.messages.at(-1)!).startsWith("You are writing") ? "SUMMARY" : "r".repeat(500) }), { contextWindow: 1000 });
    const kernel = createKernel({ llm, env, system: "s", plugins: [plugin], compaction: { reserveTokens: 200, keepRecentTokens: 150 }, now: () => 1 });
    for (let turn = 0; turn < turns; turn++) {
      await between?.(turn);
      const handle = kernel.run(log, `${turn}:${"u".repeat(400)}`);
      for await (const _event of handle.events) void _event;
    }
    return llm;
  }
  const pinned = async (log: ReturnType<typeof createMemoryLog>) => (await log.branch()).filter((entry) => entry.type === "custom_message" && entry.customType === "agents_md");

  it("re-reads AGENTS.md when the history is compacted and the file has changed", async () => {
    await writeFile(join(dir, "AGENTS.md"), "version one");
    const log = createMemoryLog();
    const llm = await converse(contextPlugin(), log, 8, async (turn) => {
      if (turn === 1) await writeFile(join(dir, "AGENTS.md"), "version two");
    });
    expect((await log.branch()).some((entry) => entry.type === "compaction")).toBe(true);
    expect((await pinned(log)).length).toBe(2);
    const last = llm.requests.filter((request) => !textOf(request.messages.at(-1)!).startsWith("You are writing")).at(-1)!;
    expect(
      last.messages
        .map(textOf)
        .filter((message) => message.includes("Instructions from"))
        .at(-1),
    ).toContain("version two");
    expect(last.messages.map(textOf).some((message) => message.includes("replace all earlier"))).toBe(true);
  });

  it("writes nothing when the file did not change", async () => {
    await writeFile(join(dir, "AGENTS.md"), "stable");
    const log = createMemoryLog();
    await converse(contextPlugin(), log, 8);
    expect((await log.branch()).some((entry) => entry.type === "compaction")).toBe(true);
    expect((await pinned(log)).length).toBe(1);
  });

  it("does not look at the file between compactions", async () => {
    await writeFile(join(dir, "AGENTS.md"), "version one");
    const log = createMemoryLog();
    await converse(contextPlugin(), log, 2, async (turn) => {
      if (turn === 1) await writeFile(join(dir, "AGENTS.md"), "version two");
    });
    expect((await log.branch()).some((entry) => entry.type === "compaction")).toBe(false);
    expect((await pinned(log)).length).toBe(1);
  });

  it("a project without AGENTS.md stays without after compaction", async () => {
    const log = createMemoryLog();
    await converse(contextPlugin(), log, 8);
    expect((await pinned(log)).length).toBe(0);
  });

  it("a file that appears later is picked up at the next compaction", async () => {
    const log = createMemoryLog();
    await converse(contextPlugin(), log, 8, async (turn) => {
      if (turn === 1) await writeFile(join(dir, "AGENTS.md"), "new rules");
    });
    expect((await pinned(log)).length).toBe(1);
  });
});

describe("context: exact wording and the size limit", () => {
  const instructions = async (plugin: ReturnType<typeof contextPlugin>) => {
    const { log } = await run(plugin);
    return (await log.project()).filter((message) => textOf(message).startsWith("Instructions from")).map(textOf);
  };

  it("a file of exactly maxBytes is kept whole; one byte more is cut and says so", async () => {
    await writeFile(join(dir, "AGENTS.md"), "0123456789");
    expect(await instructions(contextPlugin({ maxBytes: 10 }))).toEqual([`Instructions from this project (${join(dir, "AGENTS.md")}):\n\n0123456789`]);
    await writeFile(join(dir, "AGENTS.md"), "0123456789X");
    expect(await instructions(contextPlugin({ maxBytes: 10 }))).toEqual([`Instructions from this project (${join(dir, "AGENTS.md")}):\n\n0123456789\n\n[The file was cut after 10 bytes.]`]);
  });

  it("the user's file comes first, with its own label, separated from the project's by a rule", async () => {
    const userFile = join(dir, "user.md");
    await writeFile(userFile, "user rules");
    await writeFile(join(dir, "AGENTS.md"), "project rules");
    expect(await instructions(contextPlugin({ userFile }))).toEqual([
      `Instructions from the user's global file (${userFile}):\n\nuser rules\n\n---\n\nInstructions from this project (${join(dir, "AGENTS.md")}):\n\nproject rules`,
    ]);
  });

  it("with cwd: false only the user's file is read", async () => {
    const userFile = join(dir, "user.md");
    await writeFile(userFile, "user rules");
    await writeFile(join(dir, "AGENTS.md"), "project rules");
    expect(await instructions(contextPlugin({ userFile, cwd: false }))).toEqual([`Instructions from the user's global file (${userFile}):\n\nuser rules`]);
  });

  it("names itself and says what it compensates", () => {
    const plugin = contextPlugin();
    expect(plugin.name).toBe("context");
    expect(plugin.compensates).toBe("models start every session knowing nothing about the project's rules");
  });
});

describe("context: what happens to the instructions when the file changes", () => {
  it("a file that is removed or emptied does not take the instructions back, also after a reload", async () => {
    await writeFile(join(dir, "AGENTS.md"), "Always answer in French.");
    const plugin = contextPlugin();
    const log = createMemoryLog();
    await run(plugin, log);
    await rm(join(dir, "AGENTS.md"));
    expect(await plugin.reload({ log, env })).toBe(false);
    await writeFile(join(dir, "AGENTS.md"), "   \n");
    expect(await plugin.reload({ log, env })).toBe(false);
    const pinned = (await log.branch()).filter((entry) => entry.type === "custom_message" && entry.pinned);
    expect(pinned).toHaveLength(1);
    expect(JSON.stringify(pinned[0])).toContain("Always answer in French.");
  });

  it("a changed file replaces the instructions, and the new text says so", async () => {
    await writeFile(join(dir, "AGENTS.md"), "Use tabs.");
    const plugin = contextPlugin();
    const log = createMemoryLog();
    await run(plugin, log);
    await writeFile(join(dir, "AGENTS.md"), "Use spaces.");
    expect(await plugin.reload({ log, env })).toBe(true);
    const last = (await log.branch()).filter((entry) => entry.type === "custom_message").at(-1);
    expect(JSON.stringify(last)).toContain("These instructions replace all earlier project instructions.");
    expect(JSON.stringify(last)).toContain("Use spaces.");
  });
});
