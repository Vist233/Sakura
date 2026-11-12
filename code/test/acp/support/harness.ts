// An in-process ACP session for tests: our agent on one end of a pair of in-memory streams, the SDK's own client on the other.
// The SDK validates every message in both directions against the protocol schema, so a malformed message from the agent fails here.
import { join } from "node:path";
import { client, ndJsonStream, methods } from "@agentclientprotocol/sdk";
import type { ClientConnection, NewSessionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { DEFAULT_SETTINGS } from "../../../src/config.ts";
import type { Settings } from "../../../src/config.ts";
import type { Clock } from "../../../src/schedule.ts";
import { createLogger } from "../../../src/acp/log.ts";
import { runAcp } from "../../../src/acp/serve.ts";
import { createSessionStore } from "../../../src/session-store.ts";
import { openAgentSession } from "../../../src/agent-session.ts";
import type { AgentSessionRequest } from "../../../src/agent-session.ts";
import type { PermissionName } from "../../../src/permissions.ts";
import { scriptedClient } from "../../support/scripted-client.ts";
import type { Script } from "../../support/scripted-client.ts";
import type { Sandbox } from "../../support/harness.ts";

export interface Harness {
  connection: ClientConnection;
  /** Every `session/update` the client received, in order. */
  updates: SessionNotification[];
  /** Log lines the agent wrote (it would write them to stderr). */
  logs: string[];
  directory: string;
  /** `initialize` with no capabilities, then `session/new` in the sandbox directory. */
  start(): Promise<NewSessionResponse>;
  initialize(): Promise<unknown>;
  stop(): Promise<number>;
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  permissions?: PermissionName;
  /** The client may pick full-access. */
  allowFullAccess?: boolean;
  env?: Record<string, string | undefined>;
  /** Use a real provider setup (no scripted client): for the missing-key test. */
  noClients?: boolean;
  /** Receives every request to open an agent (a spy on the factory). */
  onOpen?: (request: AgentSessionRequest) => void;
  /** Time for scheduled jobs. */
  clock?: Clock;
}

export function startHarness(sandbox: Sandbox, script: Script, options: HarnessOptions = {}): Harness {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const logs: string[] = [];
  const updates: SessionNotification[] = [];
  let stopRequested!: () => void;
  const stop = new Promise<void>((resolve) => (stopRequested = resolve));
  const store = createSessionStore(join(sandbox.directory, "sessions"));
  const served = runAcp({
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    store,
    env: options.env ?? {},
    version: "9.9.9",
    permissions: options.permissions ?? "auto",
    allowFullAccess: options.allowFullAccess ?? false,
    streams: { input: toAgent.readable, output: toClient.writable },
    log: createLogger((line) => void logs.push(line), "debug"),
    ...(options.noClients ? {} : { clients: { agent: scriptedClient(script) } }),
    open: (request) => {
      options.onOpen?.(request);
      return openAgentSession(request);
    },
    ...(options.clock ? { clock: options.clock } : {}),
    stop,
  });
  const connection = client()
    .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
    .connect(ndJsonStream(toAgent.writable, toClient.readable));
  const initialize = () => connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  return {
    connection,
    updates,
    logs,
    directory: sandbox.directory,
    initialize,
    async start() {
      await initialize();
      return connection.agent.request(methods.agent.session.new, { cwd: sandbox.directory, mcpServers: [] });
    },
    async stop() {
      stopRequested();
      return served;
    },
  };
}
