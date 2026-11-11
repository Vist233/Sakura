// The ACP agent: routes the protocol methods to the session registry and the pure mappers. It knows nothing of JSON-RPC framing
// (that is `connection.ts`) and nothing of the model.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { initializeResult } from "./capabilities.ts";
import type { AgentIdentity } from "./capabilities.ts";
import { AVAILABLE_COMMANDS, parseCommand } from "./commands.ts";
import { promptContent } from "./content.ts";
import type { Content } from "../framework.ts";
import { imageMediaType } from "../images.ts";
import { expandMentions } from "../mentions.ts";
import { describeCheck, goalChecks } from "./goal-notes.ts";
import { clientMcpServers } from "./mcp.ts";
import { replayUpdates } from "./replay.ts";
import { createUpdateMapper } from "./events-to-updates.ts";
import type { Logger } from "./log.ts";
import type { Sessions } from "./sessions.ts";
import { outcomeOf } from "./stop-reasons.ts";
import { AcpError, ErrorCode } from "./types.ts";
import type { ClientChannel, ConfigOption, InitializeParams, InitializeResult, NewSessionParams, NewSessionResult, LoadSessionParams, LoadSessionResult, PromptParams, PromptResult, SetConfigParams, SetConfigResult, SetModeParams } from "./types.ts";

export interface AgentHandlers {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  authenticate(params: unknown): Promise<Record<string, never>>;
  newSession(params: NewSessionParams, channel: ClientChannel): Promise<NewSessionResult>;
  loadSession(params: LoadSessionParams, channel: ClientChannel): Promise<LoadSessionResult>;
  setConfigOption(params: SetConfigParams, channel: ClientChannel): Promise<SetConfigResult>;
  /** The older form of the review-mode selector. */
  setMode(params: SetModeParams, channel: ClientChannel): Promise<Record<string, never>>;
  /** `signal` aborts when the client cancels this request with `$/cancel_request`; that ends the turn like `session/cancel`. */
  prompt(params: PromptParams, channel: ClientChannel, signal?: AbortSignal): Promise<PromptResult>;
  cancel(params: { sessionId: string }): Promise<void>;
}

export interface AcpAgentDeps {
  sessions: Sessions;
  identity: AgentIdentity;
  log: Logger;
  /** The home directory, for `@~/path`. */
  home?: string | undefined;
  /** Told when a session is opened and when a turn ends, so it can compact an idle one. */
  idle?: { touch(sessionId: string): void };
}

export function createAcpAgent(deps: AcpAgentDeps): AgentHandlers {
  const { sessions, log } = deps;

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

  /** After the agent was rebuilt: the new selectors, the mode if it changed (for clients that only know modes), and the meter (another model has another window). */
  const announceChange = async (sessionId: string, channel: ClientChannel, modeBefore: string, configOptions: ConfigOption[]) => {
    await channel.update(sessionId, { sessionUpdate: "config_option_update", configOptions });
    const mode = sessions.mode(sessionId);
    if (mode !== modeBefore) await channel.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
    await channel.update(sessionId, { sessionUpdate: "usage_update", ...(await sessions.measure(sessionId)) });
  };

  /** The client learns the session id from the answer, so the menu of commands follows it. */
  const announceCommands = (sessionId: string, channel: ClientChannel) =>
    void setTimeout(() => void channel.update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [...AVAILABLE_COMMANDS] }).catch(() => undefined), 0);

  return {
    initialize: guard("initialize", async (params) => {
      return initializeResult(params, deps.identity);
    }),
    // no authentication is needed yet (keys come from the environment), so there is nothing to do and nothing can fail
    authenticate: guard("authenticate", async () => ({})),
    newSession: guard("session/new", async (params, channel) => {
      if (typeof params.cwd !== "string" || !isAbsolute(params.cwd)) throw new AcpError(ErrorCode.invalidParams, "cwd must be an absolute path", { cwd: typeof params.cwd === "string" ? params.cwd : undefined });
      const mcp = clientMcpServers(params.mcpServers);
      if (mcp.skipped > 0) log.warn("session/new: MCP servers that are not a command to run were left out", { count: mcp.skipped });
      const sessionId = await sessions.create(params.cwd, mcp.servers);
      announceCommands(sessionId, channel);
      deps.idle?.touch(sessionId);
      return { sessionId, configOptions: sessions.configOptions(sessionId), modes: sessions.modeState(sessionId) };
    }),
    loadSession: guard("session/load", async (params, channel) => {
      if (typeof params.cwd !== "string" || !isAbsolute(params.cwd)) throw new AcpError(ErrorCode.invalidParams, "cwd must be an absolute path", { cwd: typeof params.cwd === "string" ? params.cwd : undefined });
      const mcp = clientMcpServers(params.mcpServers);
      if (mcp.skipped > 0) log.warn("session/load: MCP servers that are not a command to run were left out", { count: mcp.skipped });
      await sessions.load(params.sessionId, params.cwd, mcp.servers);
      // the conversation is replayed before the answer, as the protocol asks
      for (const update of replayUpdates(await sessions.history(params.sessionId), { cwd: params.cwd })) await channel.update(params.sessionId, update);
      await channel.update(params.sessionId, { sessionUpdate: "usage_update", ...(await sessions.measure(params.sessionId)) });
      announceCommands(params.sessionId, channel);
      deps.idle?.touch(params.sessionId);
      return { configOptions: sessions.configOptions(params.sessionId), modes: sessions.modeState(params.sessionId) };
    }),
    setConfigOption: guard("session/set_config_option", async (params, channel) => {
      const before = sessions.mode(params.sessionId);
      const change = await sessions.setConfig(params.sessionId, params.configId, params.value);
      if (change.applied) await announceChange(params.sessionId, channel, before, change.configOptions);
      return { configOptions: change.configOptions };
    }),
    setMode: guard("session/set_mode", async (params, channel) => {
      const before = sessions.mode(params.sessionId);
      const change = await sessions.setConfig(params.sessionId, "mode", params.modeId);
      if (change.applied) await announceChange(params.sessionId, channel, before, change.configOptions);
      return {};
    }),
    prompt: guard("session/prompt", async (params, channel, signal) => {
      const { text, images } = promptContent(params.prompt);
      if (!sessions.has(params.sessionId)) throw new AcpError(ErrorCode.sessionNotFound, `Unknown session ${params.sessionId}`, { sessionId: params.sessionId });
      if (text === "" && images.length === 0) return { stopReason: "end_turn" };
      const id = params.sessionId;
      const command = parseCommand(text);
      const say = (message: string) => channel.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message }, messageId: randomUUID() });
      if (command?.name === "status") {
        await say(await sessions.status(id));
        return { stopReason: "end_turn" };
      }
      if (command?.name === "mcp") {
        await say(sessions.mcpReport(id));
        return { stopReason: "end_turn" };
      }
      if (command?.name === "undo") {
        const undone = await sessions.undo(id);
        await say(undone === undefined ? "There is no message to undo." : `Went back to before your last message. Send it again, changed if you like:\n\n${undone}`);
        await channel.update(id, { sessionUpdate: "usage_update", ...(await sessions.measure(id)) });
        return { stopReason: "end_turn" };
      }
      if (command?.name === "fork") {
        const child = await sessions.fork(id);
        await say(child === undefined ? "There is nothing to fork yet." : `Forked into session ${child}. The conversation here is unchanged. A chat command cannot switch you to another session: open the copy with session/load (where your client offers it), or in the terminal with \`sakuracode resume ${child.slice(0, 8)}\`.`);
        return { stopReason: "end_turn" };
      }
      if (command?.name === "goal" && command.action === "show") {
        await say(await sessions.goalText(id));
        return { stopReason: "end_turn" };
      }
      if (command?.name === "goal" && command.action === "clear") {
        await sessions.clearGoal(id);
        await say("Goal cleared.");
        return { stopReason: "end_turn" };
      }
      // `/goal <objective>` sets the goal and then works on it, with the objective as the prompt (as in the terminal)
      const goalSet = command?.name === "goal" && command.action === "set" ? command.objective : undefined;
      if (goalSet !== undefined) {
        await sessions.setGoal(id, goalSet);
        await say("Goal set. Working on it now; it is checked before the agent may stop.\n\n");
      }
      const { cwd, contextWindow } = sessions.info(id);
      // `@path` (typed, or a file link the client sent) is expanded as in the terminal: the paths are named to the agent, and pictures are attached
      const mentions = await expandMentions(goalSet ?? (command?.name === "prompt" ? command.text : text), cwd, deps.home);
      const attached: Content[] = [...(await sessions.saveImages(id, images)), ...mentions.images.map((path): Content => ({ type: "image", mediaType: imageMediaType(path) ?? "image/png", ref: path }))];
      const input = attached.length === 0 ? mentions.text : [{ type: "text" as const, text: mentions.text === "" ? "(see the attached image)" : mentions.text }, ...attached];
      let checksSeen = goalChecks(await sessions.history(id)).length;
      const mapper = createUpdateMapper({ cwd, contextWindow, previous: (callId) => sessions.previous(callId) });
      const cancel = () => sessions.cancel(id);
      signal?.addEventListener("abort", cancel, { once: true });
      let turn;
      try {
        turn = await sessions.run(
          id,
          command?.name === "compact" ? undefined : input,
          async (event) => {
            // the goal check leaves its findings in the log between turns; the person sees what is left
            if (event.type === "turn_start") {
              const checks = goalChecks(await sessions.history(id));
              for (const check of checks.slice(checksSeen)) {
                const note = describeCheck(check);
                if (note) await say(note);
              }
              checksSeen = checks.length;
            }
            for (const update of mapper.push(event)) await channel.update(id, update);
            if (event.type === "tool_end") sessions.forget(event.call.id);
            if (event.type === "compaction") {
              await channel.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Context compacted (it held ${event.tokensBefore.toLocaleString("en-US")} tokens).\n\n` }, messageId: randomUUID() });
              await channel.update(id, { sessionUpdate: "usage_update", ...(await sessions.measure(id)) });
            }
          },
          command?.name === "compact" ? { compact: true } : undefined,
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
        deps.idle?.touch(id);
      }
      // a model or thinking change asked for during the turn is made now, before the answer, so no update follows the response
      const modeBefore = sessions.mode(id);
      const changed = await sessions.applyPending(id);
      if (changed) await announceChange(id, channel, modeBefore, changed);
      const outcome = outcomeOf(turn.result, turn.cancelled);
      if (outcome.notice) await channel.update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome.notice }, messageId: randomUUID() });
      return outcome.result;
    }),
    cancel: guard("session/cancel", async (params) => {
      sessions.cancel(params.sessionId);
    }),
  };
}
