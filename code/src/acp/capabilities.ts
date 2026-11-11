// What we tell the client about the agent.
import type { InitializeParams, InitializeResult } from "./types.ts";

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
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
    },
    // Keys come from the environment of the agent process; there is nothing to log in to yet.
    authMethods: [],
    agentInfo: identity,
  };
}
