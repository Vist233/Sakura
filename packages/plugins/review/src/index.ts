import type { Decision, LlmClient, Log, PauseReason, Plugin, Tool, ToolCall } from "@sakura/kernel";
import { runChain } from "./chain.ts";
import type { Authorizer } from "./chain.ts";
import { hardRules } from "./hard-rules.ts";
import { resolvePolicy } from "./policy.ts";
import type { PolicyInput } from "./policy.ts";
import { createReviewer } from "./reviewer.ts";

export type { Authorizer, Verdict } from "./chain.ts";
export type { PolicyInput } from "./policy.ts";

export interface BreakerOptions {
  /** Stop the run after this many refusals in a row. */
  consecutive?: number;
  /** Stop the run after `denies` refusals among the last `size` reviews. */
  window?: { size: number; denies: number };
}

export interface ReviewOptions {
  /** The model that reviews. Usually the same one as the agent's. */
  llm: LlmClient;
  policy?: PolicyInput;
  /** Extra authorizers, asked after the hard rules and before the reviewer. */
  authorizers?: Authorizer[];
  timeoutMs?: number;
  /** Off unless given. When it trips, refusals continue and the run is paused for the owner to look at. */
  breaker?: BreakerOptions;
}

/** What a plugin needs to ask for a review of a call it makes itself (the log, a way to stop, and a way to find tools by name). */
export interface AuthorizeContext {
  log: Log;
  signal: AbortSignal;
  tool(name: string): Tool | undefined;
  /** The working directory the call runs in (optional; without it any absolute path counts as outside). */
  cwd?: string;
}

export interface ReviewPlugin extends Plugin {
  /**
   * The same review a tool call gets from the loop, for calls that do not pass through it (a script that calls tools, for example).
   * Hand this function to such a plugin as an option. The decision is counted for the run's breaker and shown as a `review` event, like any other.
   */
  authorize(call: ToolCall, context: AuthorizeContext): Promise<Extract<Decision, { kind: "allow" | "deny" }>>;
  /**
   * Stops the loop from reviewing calls to this tool itself. For a tool that only runs other tools and has each of them reviewed through `authorize`
   * (code mode's `run_code`), so one script is not reviewed twice. `createAgent` does this for code mode; a plugin wired by hand is reviewed as a whole unless told.
   */
  exempt(toolName: string): void;
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => (inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));

interface RunState {
  verdicts: Map<string, { kind: "allow" | "deny"; reason: string }>;
  recent: boolean[]; // true = refused
  consecutive: number;
  tripped: boolean;
}

/**
 * Automatic review of tool calls, with nobody to ask: hard rules, then any extra authorizers, then a reviewer
 * model, and a refusal at the end of the chain. A refusal goes back to the agent as a tool error so it can choose
 * another way. It is a plugin and off unless you add it.
 */
export function reviewPlugin(options: ReviewOptions): ReviewPlugin {
  const policy = resolvePolicy(options.policy);
  const states = new WeakMap<Log, RunState>();
  const fresh = (): RunState => ({ verdicts: new Map(), recent: [], consecutive: 0, tripped: false });
  const reviewer = createReviewer({ llm: options.llm, policy, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  const chain = [hardRules, ...(options.authorizers ?? []), reviewer];

  function record(state: RunState, refused: boolean): void {
    state.recent.push(refused);
    if (state.recent.length > (options.breaker?.window?.size ?? 50)) state.recent.shift();
    state.consecutive = refused ? state.consecutive + 1 : 0;
    const { consecutive, window } = options.breaker ?? {};
    if ((consecutive !== undefined && state.consecutive >= consecutive) || (window !== undefined && state.recent.filter(Boolean).length >= window.denies)) state.tripped = true;
  }

  let emit: (data: unknown) => void = () => undefined;
  const exempted = new Set<string>();

  async function authorize(call: ToolCall, context: AuthorizeContext): Promise<Extract<Decision, { kind: "allow" | "deny" }>> {
    const state = states.get(context.log) ?? fresh();
    states.set(context.log, state);
    if (state.tripped) return { kind: "deny", reason: "Too many actions were refused in this run, so further actions are blocked until the owner looks at it." };

    const key = `${call.name}\u0000${stable(call.args)}`;
    const cached = state.verdicts.get(key);
    const result = cached
      ? { ...cached, decidedBy: "cache" }
      : await runChain(chain, call, { log: context.log, signal: context.signal, tool: context.tool, ...(context.cwd !== undefined ? { cwd: context.cwd } : {}) });
    if (!cached) {
      if (result.decidedBy === "reviewer") state.verdicts.set(key, { kind: result.kind, reason: result.reason });
      record(state, result.kind === "deny");
    }
    emit({ kind: "review", tool: call.name, callId: call.id, outcome: result.kind, decidedBy: result.decidedBy, reason: result.reason });

    if (result.kind === "allow") return { kind: "allow" };
    return { kind: "deny", reason: `${result.reason} Do not try the same action again; choose another approach, or tell the user what you need.` };
  }

  return {
    name: "review",
    compensates: "models act without anyone checking the risky ones",
    authorize,
    exempt: (toolName) => void exempted.add(toolName),
    async prepare({ log }) {
      states.set(log, fresh()); // decisions are remembered within one run only
    },
    setup(api) {
      emit = api.emit;
      api.on("tool.before", (call: ToolCall, context) =>
        exempted.has(call.name) ? undefined : authorize(call, { log: context.log, signal: context.signal, tool: context.tool, cwd: context.env.cwd }),
      );
      api.on("turn.end", ({ log }) => (states.get(log)?.tripped ? { pause: "approval" as PauseReason } : undefined));
    },
  };
}
