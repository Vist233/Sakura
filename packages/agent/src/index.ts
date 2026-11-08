import { createChatClient } from "@sakura/llm";
import type { ChatCompat } from "@sakura/llm";
import { createLocalEnvironment } from "@sakura/env";
import { createKernel } from "@sakura/kernel";
import type { CompactionConfig, Environment, LlmClient, Plugin, Prompts, RunHandle, ThinkingLevel, UserInput } from "@sakura/kernel";
import { agentsPlugin } from "@sakura/plugin-agents";
import type { AgentDefinition } from "@sakura/plugin-agents";
import { contextPlugin } from "@sakura/plugin-context";
import { codemodePlugin, connectMcp, searchPlugin } from "@sakura/plugin-toolset";
import type { Authorize, McpServerConfig, McpServerStatus } from "@sakura/plugin-toolset";
import { limitsPlugin } from "@sakura/plugin-limits";
import { resiliencePlugin } from "@sakura/plugin-resilience";
import { builtinTools, toolsPlugin } from "@sakura/plugin-tools";
import { createMemoryLog, openFileLog } from "@sakura/session";
import type { FileLog, RewindableLog } from "@sakura/session";
import { compose } from "./compose.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export interface ModelConfig {
  /** Base URL without /chat/completions, for example https://api.deepseek.com */
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  compat?: Partial<ChatCompat>;
  headers?: Record<string, string>;
}

export interface AgentConfig {
  /** A provider to talk to, or a ready-made client (for tests). */
  model: ModelConfig | LlmClient;
  cwd?: string;
  tools?: Array<"read" | "write" | "edit" | "bash">;
  /** After this many milliseconds a running shell command is moved to the background (default 120000). */
  bashSoftTimeoutMs?: number;
  /** How long a command the model starts with `background: true` is watched before it is left to run (default 1000), so that one that fails at once is reported as failed. */
  bashBackgroundGraceMs?: number;
  /** Defaults to corePlugins(). Safety plugins (review, redaction, sub-agents) are never in the default set. May contain bundles and plugins that say what they require; see compose(). */
  plugins?: Plugin[];
  /** Replaces the generated system prompt. */
  system?: string;
  /** Write the conversation to this JSONL file; without it the conversation lives in memory only. */
  sessionFile?: string;
  thinking?: ThinkingLevel;
  maxTokens?: number;
  goal?: { objective: string; verify?: string };
  compaction?: false | Partial<CompactionConfig>;
  prompts?: Partial<Prompts>;
  environment?: Environment;
  now?: () => number;
  /**
   * Wakes the agent by itself. When background work ends (a command moved to the background, a background sub-agent) and no run is going,
   * a run is started so the agent hears about it; `onRun` receives each such run (to show its events). While work is still pending and the agent
   * is quiet, it is woken once after `cacheCheckMs` (default 4 minutes, a little under the prompt cache lifetime) to check, and then left alone until something ends.
   */
  wake?: { onRun(handle: RunHandle): void; cacheCheckMs?: number };
  /**
   * MCP servers, started once when the agent is created (a server that fails is left out and shows in `agent.mcp`). Their tools are named mcp__<server>__<tool>.
   * `expose`: "direct" declares every tool to the model; "search" lists only tool_search and tool_call; "codemode" lists only run_code, where read-only
   * tools can be called from a script. The default is "direct" up to 10 tools and "search" above.
   */
  mcp?: { servers: Record<string, McpServerConfig>; expose?: "direct" | "search" | "codemode"; timeoutMs?: number };
  /** Turns on sub-agents (delegate, agent_view, agent_stop). Off unless this is given. */
  subAgents?: {
    agents?: AgentDefinition[];
    maxRegistered?: number;
    maxRunning?: number;
    /**
     * Plugins (by name) that sub-agents do not get. Every other plugin of the agent is shared with its sub-agents, so review and redaction
     * cannot be bypassed by delegating. Default: agents (no nesting), limits (a sub-agent has its own turn limit), context and tools (a sub-agent starts fresh).
     */
    notInherited?: string[];
    /** Models by name, for sub-agent definitions that name one (`AgentDefinition.model`). A definition whose model is not in the table uses the parent's model. */
    models?: Record<string, ModelConfig | LlmClient>;
  };
}

export interface Agent {
  /** Starts, resumes or follows up. See Kernel.run. */
  run(input?: UserInput): RunHandle;
  queue(text: string): void;
  steer(text: string): void;
  cancel(): void;
  log: RewindableLog;
  /** Goes back to an earlier point of the conversation (an entry id from `log.branch()`, or null for the very start); what is said next starts a new branch. */
  rewindTo(entryId: string | null): void;
  /** How each MCP server did when the agent was created (for the person running it; the model is not told). Empty without `mcp`. */
  mcp: Record<string, McpServerStatus>;
  /** Releases the session file lock. */
  close(): Promise<void>;
}

/** The plugins every agent gets unless the caller passes its own list: project instructions (AGENTS.md), long tool output saved to files, resilience (replies that were cut off or came back empty are asked again), and limits (unlimited until configured). */
export function corePlugins(): Plugin[] {
  return [contextPlugin(), toolsPlugin(), resiliencePlugin(), limitsPlugin()];
}

const SUB_AGENT_NOTE =
  "You are a sub-agent working for another agent. Do the task you are given completely, then finish with a clear written report of what you did and found. That report is the only thing that goes back to the agent that asked.";

const CACHE_CHECK_MS = 240_000;

const checkInput = (labels: string[]): string =>
  `Background work you started is still running: ${labels.join(", ")}. Check on it once now (for example read its output), then stop and wait; you will be told when it ends. Do not poll.`;

const isClient = (model: AgentConfig["model"]): model is LlmClient => "stream" in model;

export async function createAgent(config: AgentConfig): Promise<Agent> {
  const cwd = config.cwd ?? process.cwd();
  const env = config.environment ?? createLocalEnvironment(cwd);
  const connection = config.mcp ? await connectMcp(config.mcp.servers, config.mcp.timeoutMs !== undefined ? { timeoutMs: config.mcp.timeoutMs } : {}) : undefined;
  const mcpTools = connection?.tools ?? [];
  const expose = config.mcp?.expose ?? (mcpTools.length > 10 ? "search" : "direct");
  const bashOptions = {
    ...(config.bashSoftTimeoutMs !== undefined ? { softTimeoutMs: config.bashSoftTimeoutMs } : {}),
    ...(config.bashBackgroundGraceMs !== undefined ? { backgroundGraceMs: config.bashBackgroundGraceMs } : {}),
  };
  const tools = builtinTools(config.tools, { bash: bashOptions });
  const declared = expose === "direct" ? [...tools, ...mcpTools] : tools;
  const clientFor = (model: ModelConfig | LlmClient): LlmClient =>
    isClient(model)
      ? model
      : createChatClient({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          contextWindow: model.contextWindow,
          ...(model.compat ? { compat: model.compat } : {}),
          ...(model.headers ? { headers: model.headers } : {}),
        });
  const llm = clientFor(config.model);
  const thinkingModel = !isClient(config.model) && config.model.compat?.thinkingFormat !== undefined && config.model.compat.thinkingFormat !== "none";
  const thinking = config.thinking ?? (thinkingModel ? "medium" : undefined);

  const system = config.system ?? buildSystemPrompt({ tools, cwd: env.cwd, platform: process.platform });
  // bundles are opened and a plugin that appears twice is installed once; a missing requirement, a cycle or two plugins with one name fail here, before anything runs
  const plugins = compose(config.plugins ?? corePlugins());
  const notInherited = new Set(config.subAgents?.notInherited ?? ["agents", "limits", "context", "tools"]);
  const inherited = plugins.filter((plugin) => !notInherited.has(plugin.name));
  if (mcpTools.length > 0 && expose === "search") plugins.push(searchPlugin({ catalog: mcpTools }));
  // a plugin that offers `authorize` (the review plugin does) is asked before each call a script makes, because those calls do not pass the loop's hooks
  const reviewer = plugins.find((plugin) => typeof (plugin as { authorize?: unknown }).authorize === "function") as { authorize?: Authorize; exempt?: (toolName: string) => void } | undefined;
  const authorize = reviewer?.authorize;
  if (mcpTools.length > 0 && expose === "codemode") {
    plugins.push(codemodePlugin({ catalog: mcpTools, ...(authorize ? { authorize } : {}) }));
    // every call a script makes is reviewed one by one, so the script as a whole is not reviewed again
    reviewer?.exempt?.("run_code");
  }
  const childLogs: FileLog[] = [];
  const childModels = new Map(Object.entries(config.subAgents?.models ?? {}).map(([name, model]) => [name, clientFor(model)]));
  if (config.subAgents) {
    const childLogDirectory = config.sessionFile?.replace(/\.jsonl$/, "") ?? undefined;
    plugins.push(
      agentsPlugin({
        ...(({ models: _models, notInherited: _notInherited, ...rest }) => rest)(config.subAgents),
        createChild: ({ definition, maxTurns, model }) =>
          createKernel({
            llm: (model !== undefined && childModels.get(model)) || llm,
            env,
            system: `${definition.systemPrompt ?? system}\n\n${SUB_AGENT_NOTE}`,
            tools: definition.tools ? tools.filter((tool) => definition.tools?.includes(tool.name)) : tools,
            plugins: maxTurns !== undefined ? [...inherited, limitsPlugin({ maxTurns })] : inherited,
            ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
            ...(thinking !== undefined ? { thinking } : {}),
            ...(config.compaction !== undefined ? { compaction: config.compaction } : {}),
          }),
        ...(childLogDirectory
          ? {
              openLog: async (id: string) => {
                const log = await openFileLog(`${childLogDirectory}/agents/${id}.jsonl`, { cwd: env.cwd });
                childLogs.push(log);
                return log;
              },
            }
          : {}),
      }),
    );
  }

  const kernel = createKernel({
    llm,
    env,
    system,
    tools: declared,
    plugins,
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(config.now ? { now: config.now } : {}),
    ...(config.wake ? { onSignal: () => onBackgroundEnd() } : {}),
    ...(config.compaction !== undefined ? { compaction: config.compaction } : {}),
    ...(config.goal ? { goal: config.goal } : {}),
    ...(config.prompts ? { prompts: config.prompts } : {}),
  });

  const fileLog: FileLog | undefined = config.sessionFile ? await openFileLog(config.sessionFile, { cwd: env.cwd }) : undefined;
  const log: RewindableLog = fileLog ?? createMemoryLog();
  let active: RunHandle | undefined;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let checkUsed = false; // the one proactive check per quiet period has been made

  function start(input: UserInput | undefined): RunHandle {
    const handle = kernel.run(log, input);
    active = handle;
    void handle.result.finally(() => {
      if (active === handle) active = undefined;
      afterRun();
    });
    return handle;
  }

  function wakeWith(input: string | undefined): void {
    if (closed || active || !config.wake) return;
    config.wake.onRun(start(input));
  }

  function onBackgroundEnd(): void {
    clearTimeout(timer);
    checkUsed = false;
    wakeWith(undefined); // while a run is going, it delivers the notice itself or afterRun does
  }

  /** Called when a run ends: wakes for anything the run did not get to tell the agent, or arms the one check before the cache expires. */
  function afterRun(): void {
    if (closed || !config.wake) return;
    const pending = kernel.pending(log);
    if (pending.signals.length > 0) {
      wakeWith(undefined);
      return;
    }
    if (pending.watching.length === 0 || checkUsed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = kernel.pending(log);
      if (now.signals.length > 0) return wakeWith(undefined);
      if (now.watching.length === 0) return;
      checkUsed = true;
      wakeWith(checkInput(now.watching));
    }, config.wake.cacheCheckMs ?? CACHE_CHECK_MS);
    timer.unref();
  }

  return {
    log,
    mcp: connection?.status ?? {},
    rewindTo: (entryId) => log.rewindTo(entryId),
    run: (input) => start(input),
    queue: (text) => active?.queue(text),
    steer: (text) => active?.steer(text),
    cancel: () => active?.cancel(),
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await connection?.close();
      await env.dispose(); // stops commands that are still running in the background
      await Promise.all(childLogs.map((log) => log.close()));
      await fileLog?.close();
    },
  };
}

export { buildSystemPrompt } from "./system-prompt.ts";
export { bundle, compose, CompositionError } from "./compose.ts";
export type { Composable } from "./compose.ts";
