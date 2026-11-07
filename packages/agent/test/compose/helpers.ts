import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginApi } from "@sakura/kernel";
import { createFauxClient } from "@sakura/testing";
import type { FauxTurn } from "@sakura/testing";
import { createAgent } from "../../src/index.ts";

export async function drain(handle: { events: AsyncIterable<unknown>; result: Promise<{ reason: string; error?: string }> }) {
  for await (const _event of handle.events) void _event;
  return handle.result;
}

/** Runs one agent with the given plugins against a scripted model, in a throw-away directory. */
export async function withAgent<T>(
  plugins: Plugin[],
  script: FauxTurn[],
  body: (agent: Awaited<ReturnType<typeof createAgent>>, client: ReturnType<typeof createFauxClient>, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "compose-"));
  const client = createFauxClient(script);
  const agent = await createAgent({ model: client, cwd: dir, plugins });
  try {
    return await body(agent, client, dir);
  } finally {
    await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export const textOf = (message: { content: Array<{ type: string; text?: string }> }) => message.content.map((part) => part.text ?? "").join("");

/** What a bundle must not be: only setup is passed on, so prepare and afterCompaction of the children are lost. Kept to show the difference. */
export function naiveBundle(name: string, children: Plugin[]): Plugin {
  return {
    name,
    setup(api: PluginApi) {
      for (const child of children) child.setup(api);
    },
  };
}
