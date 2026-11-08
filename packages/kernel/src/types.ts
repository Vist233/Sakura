// Public types of the kernel. Every other package depends on this file and on
// nothing else of the kernel, so the three interfaces the kernel needs from the
// outside world (LlmClient, Log, Environment) are defined here.

// ---------- messages ----------

export type Role = "user" | "assistant" | "tool" | "system";
export type StopReason = "stop" | "tool_use" | "length" | "aborted" | "error";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; ref: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  // Vendor-private data (for example reasoning_content) kept verbatim and replayed to the same vendor.
  | { type: "provider"; vendor: string; data: unknown };

export interface Message {
  role: Role;
  content: Content[];
  ts: number;
  usage?: Usage;
  stop?: StopReason;
  /** Set on role "tool": the call this message answers. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  content: Content[];
  isError?: boolean;
  details?: unknown;
}

// ---------- session log ----------

export type PauseReason = "quota" | "budget" | "approval" | "input" | "blocked";
export type GoalStatus = "active" | "blocked" | "complete";

export interface GoalRecord {
  objective: string;
  /** Shell command that must exit 0 before the goal counts as complete. */
  verify?: string;
  status: GoalStatus;
  /** Consecutive wrap-up checks that found items only a human can do. */
  humanStreak: number;
}

export type EntryBody =
  | { type: "message"; message: Message }
  | { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number }
  | { type: "context_edit"; targetId: string; replacement: Content[] | null }
  | { type: "usage"; kind: string; usage: Usage }
  | { type: "custom"; customType: string; data: unknown }
  /** Enters the model's context. `pinned` entries survive compaction (AGENTS.md). */
  | { type: "custom_message"; customType: string; content: Content[]; pinned?: boolean }
  | { type: "tool_started"; toolCallId: string; toolName: string }
  | { type: "paused"; reason: PauseReason }
  | { type: "goal"; goal: GoalRecord }
  /** What the system prompt and the tool declarations are, or how they changed (see system.ts). */
  | { type: "system_patch"; sections?: Record<string, string | null>; toolsAdded?: ToolDecl[]; toolsRemoved?: string[] };

export type LogEntry = EntryBody & { id: string; parentId: string | null; ts: number };

/** The append-only conversation log. Implemented by the session package. */
export interface Log {
  append(body: EntryBody): Promise<LogEntry>;
  /** Entries from the root to the current leaf. */
  branch(): Promise<readonly LogEntry[]>;
  /**
   * The messages to send to the model (compaction and edits applied). With `upTo`, the messages as they
   * were visible before the entry with that id, which is what a compaction summarises.
   */
  project(upTo?: string): Promise<Message[]>;
}

// ---------- model ----------

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: Message[];
  tools: ToolDecl[];
  maxTokens?: number;
  thinking?: ThinkingLevel;
}

export type LlmEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "provider"; vendor: string; data: unknown }
  | { type: "tool_call"; call: ToolCall }
  /** The output was cut off in the middle of a tool call (finish_reason "length"). */
  | { type: "tool_call_truncated"; id: string; name: string }
  | { type: "usage"; usage: Usage }
  /** The connection failed part-way and the request is being sent again: everything received so far for this reply is void. */
  | { type: "restart" }
  | { type: "done"; stop: StopReason };

export interface ModelInfo {
  id: string;
  contextWindow: number;
  supportsImages: boolean;
}

export interface LlmClient {
  model: ModelInfo;
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
}

export type ProviderErrorKind = "rate_limit" | "quota" | "overloaded" | "context_overflow" | "auth" | "network" | "invalid_request" | "other";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  /** Delay the server asked for before trying again. */
  readonly retryAfterMs: number | undefined;
  constructor(kind: ProviderErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------- environment ----------

export interface ExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

/** A command that was started and may still be running. */
export interface ProcessHandle {
  pid: number;
  /** File the output is written to as it arrives. */
  outputFile: string;
  /**
   * Resolves when the command has finished and its output has been written. Rejects only when the environment lost contact with the command and
   * cannot say how it ended (a remote machine that stopped answering); the message says so, and where the output is being written.
   */
  wait(): Promise<ExecResult>;
  /** Stops the command and everything it started. */
  kill(): void;
  readonly finished: boolean;
}

/** Where tools run. The local implementation has no sandbox: to confine commands or run them elsewhere, an application supplies its own Environment. */
export interface Environment {
  cwd: string;
  /**
   * What the model should know about where its tools run, when that is not simply this machine: it is put into the system prompt. A remote machine, for
   * example, says that commands go over a connection that can fail. Left out for an environment that is just the local machine.
   */
  description?: string;
  resolve(path: string): string;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileInfo | undefined>;
  list(path: string): Promise<string[]>;
  /** Runs a command to the end. */
  exec(command: string, options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecResult>;
  /** Starts a command and returns at once, so the caller can decide to wait or let it run in the background. */
  spawn(command: string, options: { cwd?: string; signal?: AbortSignal }): ProcessHandle;
  /** Stops everything that is still running. Called when the session ends. */
  dispose(): Promise<void>;
}

// ---------- tools ----------

export type ToolEffect = "read" | "write" | "exec" | "network" | "irreversible";

export interface ToolContext {
  env: Environment;
  signal: AbortSignal;
  callId: string;
  /** The conversation this call belongs to. */
  log: Log;
  /** Tells the agent that something changed (for example a background command finished). Delivered before its next request. */
  notify(text: string): void;
  /**
   * Says that something is going on in the background. Call the returned function with the text to tell the agent when it ends; until then the work counts as pending.
   * `wake` says whether the end should wake an agent that has gone quiet (the host decides what that means); left out, the host's own setting applies.
   * The function that reports the end may take its own `wake`, which wins for that ending (work that was stopped because the run was cancelled should not wake the agent).
   */
  watch(label: string, options?: { wake?: boolean }): (text: string, ending?: { wake?: boolean }) => void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: ToolEffect;
  /** "safe" tools may be re-run after a crash; "never" tools get an "interrupted" result instead. Default "safe". */
  replay?: "safe" | "never";
  executionMode?: "parallel" | "serial";
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

// ---------- events ----------

export type RunEndReason = "done" | "cancelled" | "paused" | "error";

export type Event =
  | { type: "run_start" }
  | { type: "run_end"; reason: RunEndReason }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; delta: Content }
  /** The reply that was being streamed is void (the request was sent again after a dropped connection). */
  | { type: "message_reset" }
  | { type: "message_end"; message: Message }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  | { type: "paused"; reason: PauseReason }
  | { type: "compaction"; tokensBefore: number }
  | { type: "goal"; status: GoalStatus }
  /** Something changed that the agent has not been told about yet. A caller may start a run to tell it. */
  | { type: "signal"; text: string }
  | { type: "plugin"; name: string; data: unknown };

// ---------- hooks and plugins ----------

export type Decision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "rewrite"; args: unknown };

/** Everything the session has spent so far, counted from the log (so it survives restarts). */
export interface UsageTotals extends Usage {
  /** Number of model replies. */
  turns: number;
}

export interface TurnInfo {
  log: Log;
  messages: Message[];
  toolCallCount: number;
  totals: UsageTotals;
}

/** Rewrites the model's reply as it arrives. May hold events back (to see what follows) and release them at the end. */
export interface EventTransform {
  push(event: LlmEvent): LlmEvent[];
  flush(): LlmEvent[];
}

/** Thrown by a hook that must not be skipped: the request is not sent and the run ends with an error. */
export class FatalHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalHookError";
  }
}

/** What a hook may look at besides its own arguments. */
export interface HookContext {
  log: Log;
  env: Environment;
  signal: AbortSignal;
  /** Looks up a tool by name (to see its declared effect, for example). */
  tool(name: string): Tool | undefined;
}

export interface Hooks {
  /** Rewrite the messages sent to the model. */
  context(input: { messages: Message[] }): Message[] | void;
  /**
   * Last chance to change the request (tools, parameters). May also return a transform for the model's reply
   * (to undo changes made to the request, such as redaction).
   */
  request(request: LlmRequest): LlmRequest | { request: LlmRequest; transform?: EventTransform } | void;
  "tool.before"(call: ToolCall, context: HookContext): Decision | void | Promise<Decision | void>;
  /** Wraps execution (timeouts, background, queues). */
  "tool.run"(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>;
  "tool.after"(call: ToolCall, result: ToolResult): ToolResult | void;
  /** Called after every turn. Appended messages are added to the log (a trailing user message makes the run continue); `pause` stops the run. */
  "turn.end"(turn: TurnInfo): { append?: Message[]; pause?: PauseReason } | void;
  error(error: ProviderError): { pause?: PauseReason } | void;
  /** Observe only. */
  event(event: Event): void;
}

export type HookName = keyof Hooks;

export interface PluginApi {
  on<K extends HookName>(hook: K, handler: Hooks[K]): void;
  registerTool(tool: Tool): void;
  /** Sends a `plugin` event with this plugin's name to the runs that are active (for observers and logs). */
  emit(data: unknown): void;
}

export interface PrepareContext {
  log: Log;
  env: Environment;
}

export interface Plugin {
  name: string;
  /** Which weakness of today's models this plugin works around (so it can be deleted later). */
  compensates?: string;
  setup(api: PluginApi): void;
  /** Called at the start of every run, before the model is asked. Use it to put things into the log (it must be safe to call repeatedly). */
  prepare?(context: PrepareContext): Promise<void>;
  /** Called after the history has been compacted. Use it to refresh things that were put into the log earlier (project instructions, for example). */
  afterCompaction?(context: PrepareContext): Promise<void>;
}
