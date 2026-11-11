// The slice of the ACP wire format the agent uses, written as plain types. Nothing here imports the SDK: the pure mappers
// depend on these types only, and `connection.ts` is the one place where they meet the SDK's own (the compiler checks that
// they fit).

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
}

/** Any other content block (image, audio, embedded resource); the agent does not read them yet. */
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}

export type PromptBlock = TextBlock | ResourceLinkBlock | OtherBlock;

export type AcpUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: TextBlock; messageId: string }
  | { sessionUpdate: "agent_thought_chunk"; content: TextBlock; messageId: string };

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: unknown;
  clientInfo?: { name?: string; version?: string } | null;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
    mcpCapabilities: { http: boolean; sse: boolean };
  };
  authMethods: [];
  agentInfo: { name: string; title: string; version: string };
}

export interface NewSessionParams {
  cwd: string;
  mcpServers: unknown[];
}

export interface NewSessionResult {
  sessionId: string;
}

export interface PromptParams {
  sessionId: string;
  prompt: PromptBlock[];
}

export interface PromptResult {
  stopReason: StopReason;
}

/** What the agent can say to the client. */
export interface ClientChannel {
  update(sessionId: string, update: AcpUpdate): Promise<void>;
}

/** The JSON-RPC error codes the agent uses (the standard ones, plus two in the server-defined range). */
export const ErrorCode = {
  invalidParams: -32602,
  internalError: -32603,
  authRequired: -32000,
  busy: -32001,
  sessionNotFound: -32002,
} as const;

/** An error with a code the client can act on. The connection turns it into a JSON-RPC error; anything else becomes a plain internal error. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}
