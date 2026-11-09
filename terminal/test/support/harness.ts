// Shared test setup: a real framework agent on a scripted model in a temporary directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSession } from "../../src/agent-session.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import { DEFAULT_SETTINGS } from "../../src/config.ts";
import type { PermissionName } from "../../src/permissions.ts";
import type { Script, ScriptedClient } from "./scripted-client.ts";
import { scriptedClient } from "./scripted-client.ts";

export interface Sandbox {
  directory: string;
  cleanup(): Promise<void>;
}

export async function makeSandbox(): Promise<Sandbox> {
  const directory = await mkdtemp(join(tmpdir(), "sakura-term-test-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export async function openScripted(sandbox: Sandbox, script: Script, options: { permissions?: PermissionName; reviewer?: ScriptedClient; name?: string } = {}): Promise<{ session: AgentSession; client: ScriptedClient }> {
  const client = scriptedClient(script);
  const session = await openAgentSession({
    settings: DEFAULT_SETTINGS,
    provider: "scripted",
    sessionId: options.name ?? "session-1",
    sessionFile: join(sandbox.directory, `${options.name ?? "session-1"}.jsonl`),
    cwd: sandbox.directory,
    permissions: options.permissions ?? "full-access",
    redaction: false,
    env: {},
    clients: { agent: client, ...(options.reviewer ? { reviewer: options.reviewer } : {}) },
  });
  return { session, client };
}
