import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createAgent } from "../src/index.ts";

// The `read` tool answers with the path of an image inside the environment. For an environment that is another machine, that path does not
// exist here, so the image has to be read through the environment when it is sent to the model.
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const elsewhere = (): Environment => ({
  cwd: "/app",
  resolve: (path) => (path.startsWith("/") ? path : `/app/${path}`),
  readFile: async (path) => {
    if (path !== "/app/board.png") throw new Error(`no such file: ${path}`);
    return PNG;
  },
  writeFile: async () => undefined,
  stat: async (path) => (path === "/app/board.png" ? { isFile: true, isDirectory: false, size: PNG.length } : undefined),
  list: async () => [],
  exec: async () => ({ exitCode: 0, output: "", timedOut: false }),
  spawn: () => {
    throw new Error("not used");
  },
  dispose: async () => undefined,
});

const sseText = (...chunks: unknown[]) => chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
const reply = (body: string) => new Response(new TextEncoder().encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
const readCall = sseText(
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: '{"path":"board.png"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  "[DONE]",
);
const finalText = sseText({ choices: [{ index: 0, delta: { content: "I see a board." }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]");

afterEach(() => vi.unstubAllGlobals());

async function runWith(compat: Record<string, unknown>) {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return reply(bodies.length === 1 ? readCall : finalText);
  });
  const agent = await createAgent({ model: { baseUrl: "https://example.test/v1", apiKey: "k", model: "m", contextWindow: 200_000, compat }, environment: elsewhere(), tools: ["read"] });
  const run = agent.run("what is on board.png?");
  for await (const _event of run.events) void _event;
  const result = await run.result;
  await agent.close();
  return { result, bodies };
}

describe("an image read in an environment that is not this machine", () => {
  it("is sent to a model that reads images, with the bytes the environment holds", async () => {
    const { result, bodies } = await runWith({ images: true });
    expect(result.reason).toBe("done");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("is described in words to a model that cannot read images, and the run goes on", async () => {
    const { result, bodies } = await runWith({ images: false });
    expect(result.reason).toBe("done");
    expect(bodies[1]).toContain("cannot read images");
    expect(bodies[1]).not.toContain("image_url");
  });
});
