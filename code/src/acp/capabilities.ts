// What we tell the client about the agent, and what we take from what the client told us.
import type { InitializeParams, InitializeResult } from "./types.ts";

/** The client's capabilities as plain booleans. Anything missing or malformed counts as not supported. */
export interface ClientFeatures {
  readonly readTextFile: boolean;
  readonly writeTextFile: boolean;
  readonly terminal: boolean;
}

const flag = (value: unknown): boolean => value === true;
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function readClientFeatures(capabilities: unknown): ClientFeatures {
  const root = record(capabilities);
  const fs = record(root.fs);
  return Object.freeze({ readTextFile: flag(fs.readTextFile), writeTextFile: flag(fs.writeTextFile), terminal: flag(root.terminal) });
}

export const ACP_PROTOCOL_VERSION = 1;

export interface AgentIdentity {
  name: string;
  title: string;
  version: string;
}

/** The `initialize` answer. The agent speaks ACP version 1 whatever the client asks for; the client then decides whether to continue. */
export function initializeResult(_request: InitializeParams, identity: AgentIdentity): InitializeResult {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    },
    // Keys come from the environment of the agent process; there is nothing to log in to yet.
    authMethods: [],
    agentInfo: identity,
  };
}
