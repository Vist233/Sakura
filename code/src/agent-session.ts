// Creating and closing a framework agent for one choice of provider, model, permissions and session file.
// Switching the provider or the permissions means closing this and opening another on the same session file.
import { buildGuards } from "./permissions.ts";
import type { PermissionName } from "./permissions.ts";
import type { Settings } from "./config.ts";
import { buildModelConfig } from "./providers.ts";
import { corePlugins, createAgent, createChatClient } from "./framework.ts";
import type { Agent, AgentConfig, LlmClient, ModelConfig, Plugin, ThinkingLevel } from "./framework.ts";

export interface AgentSessionRequest {
  settings: Settings;
  provider: string;
  model?: string | undefined;
  sessionId: string;
  sessionFile: string;
  /** Where the tools start. Nothing is restricted to it: the agent may go anywhere. */
  cwd: string;
  permissions: PermissionName;
  redaction: boolean;
  thinking?: ThinkingLevel | undefined;
  maxTokens?: number | undefined;
  env: Record<string, string | undefined>;
  /** Ready-made clients instead of a provider (tests, and the scripted model of the end-to-end test). */
  clients?: { agent: LlmClient; reviewer?: LlmClient };
  /** Plugins added after the built-in ones (the ACP front end observes tool calls with one). */
  extraPlugins?: Plugin[];
  /** Told once for every automatic retry of a model request (the reason is the provider's own error text, never the request). */
  onRetry?: (message: string) => void;
}

export interface AgentSession {
  agent: Agent;
  provider: string;
  model: string;
  contextWindow: number;
  thinking: ThinkingLevel | undefined;
  permissions: PermissionName;
  redaction: boolean;
  sessionId: string;
  close(): Promise<void>;
}

const MARKDOWN_RULE = "Write your replies in Markdown: short paragraphs, lists where they help, and fenced code blocks with a language tag for code and commands.";

export async function openAgentSession(request: AgentSessionRequest): Promise<AgentSession> {
  const modelConfig: ModelConfig | undefined = request.clients ? undefined : buildModelConfig({ settings: request.settings, provider: request.provider, model: request.model, sessionId: request.sessionId, env: request.env });
  const agentClient = request.clients?.agent ?? createClientFor(modelConfig!, request.onRetry);
  const reviewClient = request.clients?.reviewer ?? agentClient;
  const guards = buildGuards({ permissions: request.permissions, redaction: request.redaction, reviewLlm: reviewClient });

  const config: AgentConfig = {
    model: modelConfig ?? agentClient,
    cwd: request.cwd,
    sessionFile: request.sessionFile,
    plugins: [...corePlugins(), ...guards.plugins, ...(request.extraPlugins ?? [])],
    rules: [MARKDOWN_RULE],
    ...(guards.tools ? { tools: guards.tools } : {}),
    ...(request.thinking ? { thinking: request.thinking } : {}),
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(Object.keys(request.settings.mcpServers).length > 0 ? { mcp: { servers: request.settings.mcpServers } } : {}),
  };
  const agent = await createAgent(config);
  return {
    agent,
    provider: request.provider,
    model: modelConfig?.model ?? agentClient.model.id,
    contextWindow: modelConfig?.contextWindow ?? agentClient.model.contextWindow,
    thinking: request.thinking ?? (modelConfig?.compat?.thinkingFormat && modelConfig.compat.thinkingFormat !== "none" ? "medium" : undefined),
    permissions: request.permissions,
    redaction: request.redaction,
    sessionId: request.sessionId,
    close: () => agent.close(),
  };
}

function createClientFor(model: ModelConfig, onRetry?: (message: string) => void): LlmClient {
  const retry = onRetry
    ? { onRetry: ({ attempt, delayMs, error }: { attempt: number; delayMs: number; error: { kind: string; message: string } }) => onRetry(`The provider failed (${error.kind}): ${error.message.slice(0, 300)}. Trying again in ${(delayMs / 1000).toFixed(1)} s (retry ${attempt}).`) }
    : undefined;
  return createChatClient({ baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model, contextWindow: model.contextWindow, ...(model.compat ? { compat: model.compat } : {}), ...(model.headers ? { headers: model.headers } : {}), ...(retry ? { retry } : {}) });
}

export type AgentSessionFactory = (request: AgentSessionRequest) => Promise<AgentSession>;
