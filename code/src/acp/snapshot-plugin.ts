// A framework plugin that notes what a file holds just before the `write` tool replaces it, so the client's diff can start from the
// old text. The events the agent sends to the client arrive asynchronously and cannot be relied on to come before the tool runs;
// a `tool.before` hook can.
import type { Plugin } from "../framework.ts";

/** The text a file held before a call (`null`: the file did not exist or is not a small text file), by tool call id. */
export type Snapshots = Map<string, string | null>;

const MAX_BYTES = 200_000;

export function snapshotPlugin(snapshots: Snapshots): Plugin {
  return {
    name: "acp-snapshots",
    setup(api) {
      api.on("tool.before", async (call, context) => {
        if (call.name !== "write") return;
        const path = (call.args as { path?: unknown } | null)?.path;
        let before: string | null = null;
        try {
          if (typeof path === "string" && path !== "") {
            const absolute = context.env.resolve(path);
            const info = await context.env.stat(absolute);
            if (info && !info.isDirectory && info.size <= MAX_BYTES) before = new TextDecoder("utf-8").decode(await context.env.readFile(absolute));
          }
        } catch {
          before = null;
        }
        snapshots.set(call.id, before);
      });
    },
  };
}
