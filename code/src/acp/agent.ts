// The ACP agent: routes the protocol methods to the session registry and the pure mappers. It knows nothing of JSON-RPC framing
// (that is `connection.ts`) and nothing of the model.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { initializeResult, readClientFeatures } from "./capabilities.ts";
import type { AgentIdentity, ClientFeatures } from "./capabilities.ts";
import { promptText } from "./content.ts";
import { createUpdateMapper } from "./events-to-updates.ts";
import type { Logger } from "./log.ts";
import type { Sessions } from "./sessions.ts";
import { outcomeOf } from "./stop-reasons.ts";
import { AcpError, ErrorCode } from "./types.ts";
import type { ClientChannel, InitializeParams, InitializeResult, NewSessionParams, NewSessionResult, PromptParams, PromptResult, SetConfigParams, SetConfigResult } from "./types.ts";

export interface AgentHandlers {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  authenticate(params: unknown): Promise<Record<string, never>>;
  newSession(params: NewSessionParams): Promise<NewSessionResult>;
  setConfigOption(params: SetConfigParams, channel: ClientChannel): Promise<SetConfigResult>;
  /** `signal` aborts when the client cancels this request with `$/cancel_request`; that ends the turn like `session/cancel`. */
  prompt(params: PromptParams, channel: ClientChannel, signal?: AbortSignal): Promise<PromptResult>;
  cancel(params: { sessionId: string }): Promise<void>;
}

export interface AcpAgentDeps {
  sessions: Sessions;
  identity: AgentIdentity;
  log: Logger;
}

export interface AcpAgent extends AgentHandlers {
  /** What the client advertised (the defaults before `initialize`). */
  features(): ClientFeatures;
}

export function createAcpAgent(deps: AcpAgentDeps): AcpAgent {
  const { sessions, log } = deps;
  let features: ClientFeatures = readClientFeatures(undefined);

  // every handler is wrapped once: a failure becomes an error answer with a code, never a crash, and never reaches another session
  const guard = <A extends unknown[], R>(method: string, handler: (...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      try {
        return await handler(...args);
      } catch (error) {
        if (error instanceof AcpError) throw error;
        log.error(`${method} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new AcpError(ErrorCode.internalError, "The agent hit an internal error. See its log on stderr.");
      }
    };
  };

  return {
    features: () => features,
    initialize: guard("initialize", async (params) => {
      features = readClientFeatures(params.clientCapabilities);
      return initializeResult(params, deps.identity);
    }),
    // no authentication is needed yet (keys come from the environment), so there is nothing to do and nothing can fail
    authenticate: guard("authenticate", async () => ({})),
    newSession: guard("session/new", async (params) => {
      if (typeof params.cwd !== "string" || !isAbsolute(params.cwd)) throw new AcpError(ErrorCode.invalidParams, "cwd must be an absolute path", { cwd: typeof params.cwd === "string" ? params.cwd : undefined });
      if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) log.debug("session/new: mcpServers are not used yet", { count: params.mcpServers.length });
      const sessionId = await sessions.create(params.cwd);
      return { sessionId, configOptions: sessions.configOptions(sessionId) };
    }),
    setConfigOption: guard("session/set_config_option", async (params, channel) => {
      const change = await sessions.setConfig(params.sessionId, params.configId, params.value);
      if (change.applied) await channel.update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: change.configOptions });
      return { configOptions: change.configOptions };
    }),
    prompt: guard("session/prompt", async (params, channel, signal) => {
      const text = promptText(params.prompt);
      if (!sessions.has(params.sessionId)) throw new AcpError(ErrorCode.sessionNotFound, `Unknown session ${params.sessionId}`, { sessionId: params.sessionId });
      if (text === "") return { stopReason: "end_turn" };
      const mapper = createUpdateMapper();
      const cancel = () => sessions.cancel(params.sessionId);
      signal?.addEventListener("abort", cancel, { once: true });
      let turn;
      try {
        turn = await sessions.run(params.sessionId, text, async (event) => {
          for (const update of mapper.push(event)) await channel.update(params.sessionId, update);
        });
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      // a model or thinking change asked for during the turn is made now, before the answer, so no update follows the response
      const changed = await sessions.applyPending(params.sessionId);
      if (changed) await channel.update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: changed });
      const outcome = outcomeOf(turn.result, turn.cancelled);
      if (outcome.notice) await channel.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome.notice }, messageId: randomUUID() });
      return outcome.result;
    }),
    cancel: guard("session/cancel", async (params) => {
      sessions.cancel(params.sessionId);
    }),
  };
}
