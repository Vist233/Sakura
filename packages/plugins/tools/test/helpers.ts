import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { Content, Environment, Tool, ToolResult } from "@sakura/kernel";
import { createLocalEnvironment } from "@sakura/env";
import { createMemoryLog } from "@sakura/session";

export interface Sandbox {
  dir: string;
  env: Environment;
}

/** A fresh temp directory and a local environment for every test. */
export function useSandbox(): Sandbox {
  const box = {} as Sandbox;
  beforeEach(async () => {
    box.dir = await mkdtemp(join(tmpdir(), "tools-"));
    box.env = createLocalEnvironment(box.dir);
  });
  afterEach(async () => {
    await rm(box.dir, { recursive: true, force: true });
  });
  return box;
}

export const textOf = (content: Content[]): string => content.map((part) => (part.type === "text" ? part.text : "")).join("");

export async function run(
  tool: Tool,
  env: Environment,
  args: unknown,
  signal = new AbortController().signal,
  notify: (text: string) => void = () => undefined,
): Promise<ToolResult & { text: string }> {
  const result = await tool.execute(args, { env, signal, callId: "test", log: createMemoryLog(), notify, watch: () => notify });
  return { ...result, text: textOf(result.content) };
}

export const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
export const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
