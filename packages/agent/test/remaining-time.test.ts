// A command in the foreground is never given more time than the run has left (the limits plugin knows, the bash tool asks).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limitsPlugin } from "@sakura/plugin-limits";
import { createFauxClient } from "@sakura/testing";
import { corePlugins, createAgent } from "../src/index.ts";

describe("remaining time", () => {
  it("interrupts a long command when the run's time is nearly used up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remaining-"));
    try {
      const llm = createFauxClient([{ toolCalls: [{ name: "bash", args: { command: "echo started; sleep 60" }, id: "b" }] }, { text: "ok" }]);
      const plugins = [...corePlugins().filter((plugin) => plugin.name !== "limits"), limitsPlugin({ maxRunSeconds: 2, notes: false })];
      const agent = await createAgent({ model: llm, cwd: dir, plugins });
      const started = Date.now();
      const handle = agent.run("go");
      for await (const _event of handle.events) void _event;
      await handle.result;
      expect(Date.now() - started).toBeLessThan(15_000);
      const toolMessage = (await agent.log.project()).find((message) => message.role === "tool");
      const text = toolMessage?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
      expect(text).toContain("started");
      expect(text).toContain("all the time left for this run");
      await agent.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
