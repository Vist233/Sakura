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

export interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

/** A selector the client shows for the session (the model, the thinking level). */
export interface ConfigOption {
  type: "select";
  id: string;
  name: string;
  description?: string;
  category: "model" | "thought_level" | "mode";
  currentValue: string;
  options: ConfigSelectOption[];
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolContent = { type: "content"; content: TextBlock } | { type: "diff"; path: string; oldText: string | null; newText: string };

export interface ToolLocation {
  path: string;
  line?: number;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export type AcpUpdate =
  | { sessionUpdate: "user_message_chunk"; content: TextBlock; messageId: string }
  | { sessionUpdate: "agent_message_chunk"; content: TextBlock; messageId: string }
  | { sessionUpdate: "agent_thought_chunk"; content: TextBlock; messageId: string }
  | { sessionUpdate: "config_option_update"; configOptions: ConfigOption[] }
  | { sessionUpdate: "tool_call"; toolCallId: string; name: string; title: string; kind: ToolKind; status: ToolStatus; content: ToolContent[]; locations: ToolLocation[]; rawInput: unknown }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: ToolStatus; content: ToolContent[]; rawOutput: unknown }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "usage_update"; used: number; size: number }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] };

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

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
}

export interface LoadSessionResult {
  configOptions: ConfigOption[];
  modes: ModeState;
}

export interface SetModeParams {
  sessionId: string;
  modeId: string;
}

/** The older way to offer modes; sent next to the config option for clients that only know this. */
export interface ModeState {
  currentModeId: string;
  availableModes: Array<{ id: string; name: string; description: string }>;
}

export interface NewSessionResult {
  sessionId: string;
  configOptions: ConfigOption[];
  modes: ModeState;
}

export interface SetConfigParams {
  sessionId: string;
  configId: string;
  /** A select value, or (for a boolean option, which this agent has none of) a boolean. */
  value: unknown;
}

export interface SetConfigResult {
  configOptions: ConfigOption[];
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
