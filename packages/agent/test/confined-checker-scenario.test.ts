import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import { createAgent } from "../src/index.ts";

// The shape of agent that needs no reviewer: its only tools are file tools and a checker that answers true or false (a proof checker, a test oracle,
// a validator). It has no shell, so the boundary of the working directory is all the safety there is, and no second model has to run.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-checker-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("an agent with file tools, a checker and a confined directory", () => {
  it("writes a proof, is told false, edits it, is told true, and never leaves its directory", async () => {
    const submitted: string[] = [];
    const check: Tool = {
      name: "check_proof",
      description: "Check the proof in proof.txt. Answers true or false.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      async execute(_args, { env }) {
        const text = new TextDecoder().decode(await env.readFile("proof.txt"));
        submitted.push(text);
        return { content: [{ type: "text", text: String(text.includes("QED")) }] };
      },
    };
    const client = createFauxClient([
      { toolCalls: [{ name: "write", args: { path: "proof.txt", content: "claim: 1+1=2\nsteps: ..." }, id: "w" }] },
      { toolCalls: [{ name: "check_proof", args: {}, id: "c1" }] },
      { toolCalls: [{ name: "read", args: { path: "/etc/hosts" }, id: "peek" }] }, // wandering is refused
      { toolCalls: [{ name: "edit", args: { path: "proof.txt", edits: [{ oldText: "steps: ...", newText: "steps: 1+1=2 by definition. QED" }] }, id: "e" }] },
      { toolCalls: [{ name: "check_proof", args: {}, id: "c2" }] },
      { text: "The proof checks." },
    ]);
    const agent = await createAgent({ model: client, cwd: dir, confine: true, tools: ["read", "write", "edit", check] });
    const run = agent.run("Prove that 1+1=2 in proof.txt and submit it until the checker says true.");
    for await (const _event of run.events) void _event;
    expect((await run.result).reason).toBe("done");
    expect(submitted).toHaveLength(2);
    const answers = (await agent.log.project()).filter((message) => message.role === "tool").map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
    expect(answers[1]).toBe("false");
    expect(answers[2]).toContain("outside the working directory");
    expect(answers[4]).toBe("true");
    expect(await readFile(join(dir, "proof.txt"), "utf8")).toContain("QED");
    expect(client.requests.length).toBe(6); // six model calls, and no reviewer model among them
    await agent.close();
  });
});
