import type { Decision, LlmClient, Log, PauseReason, Plugin, Tool, ToolCall, Usage } from "@sakura/kernel";
import { runChain } from "./chain.ts";
import type { Authorizer, ChainResult } from "./chain.ts";
import { createHardRules } from "./hard-rules.ts";
import { resolvePolicy } from "./policy.ts";
import type { PolicyInput } from "./policy.ts";
import { createReviewer } from "./reviewer.ts";
import type { ReviewerLimits } from "./reviewer.ts";

export type { Authorizer, Verdict } from "./chain.ts";
export type { PolicyInput } from "./policy.ts";
export type { ReviewerLimits } from "./reviewer.ts";

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
  /**
   * By default a read-only command or tool that points outside the working directory is not allowed by the hard rules but sent to the reviewer.
   * `false` removes that rule, for an application where the agent works on the whole machine and has no working directory in that sense. The other rules
   * stay: commands that write, expansions the text cannot show, credentials and the catastrophic patterns.
   */
  directoryRules?: boolean;
  /** Extra authorizers, asked after the hard rules and before the reviewer. */
  authorizers?: Authorizer[];
  timeoutMs?: number;
  /**
   * How big the reviewer's conversation may get and what goes into it (see ReviewerLimits; every field is optional). The conversation only grows, so the
   * provider's cache works, until it passes `maxThreadTokens` (default 24000); then a new one starts with the goal, the project instructions, the latest
   * user messages and a digest of the latest verdicts, which costs one cache miss. A value that is not a whole number of at least 1 throws here.
   */
  limits?: Partial<ReviewerLimits>;
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
  const reviewer = createReviewer({ llm: options.llm, policy, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.limits ? { limits: options.limits } : {}) });
  const chain = [createHardRules({ directoryRules: options.directoryRules !== false }), ...(options.authorizers ?? []), reviewer];

  function record(state: RunState, refused: boolean): void {
    state.recent.push(refused);
    if (state.recent.length > (options.breaker?.window?.size ?? 50)) state.recent.shift();
    state.consecutive = refused ? state.consecutive + 1 : 0;
    const { consecutive, window } = options.breaker ?? {};
    if ((consecutive !== undefined && state.consecutive >= consecutive) || (window !== undefined && state.recent.filter(Boolean).length >= window.denies)) state.tripped = true;
  }

  let emit: (data: unknown) => void = () => undefined;
  const exempted = new Set<string>();

  /** Every decision is written to the conversation log as a `custom` entry (never shown to the model) and what the reviewer spent as a `usage` entry. */
  async function writeRecord(log: Log, call: ToolCall, result: ChainResult, technical: boolean, latencyMs: number, usage: Usage | undefined): Promise<void> {
    try {
      await log.append({
        type: "custom",
        customType: "review",
        data: {
          callId: call.id,
          tool: call.name,
          outcome: result.kind,
          decidedBy: result.decidedBy,
          reason: result.reason,
          latencyMs,
          ...(technical ? { technical } : {}),
          ...(usage ? { usage } : {}),
        },
      });
      if (usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) await log.append({ type: "usage", kind: "review", usage });
    } catch {
      // the decision matters more than its record; the same facts go out as a `review` event
    }
  }

  async function authorize(call: ToolCall, context: AuthorizeContext): Promise<Extract<Decision, { kind: "allow" | "deny" }>> {
    const state = states.get(context.log) ?? fresh();
    states.set(context.log, state);
    if (state.tripped) return { kind: "deny", reason: "Too many actions were refused in this run, so further actions are blocked until the owner looks at it." };

    const key = `${call.name}\u0000${stable(call.args)}`;
    const cached = state.verdicts.get(key);
    const started = Date.now();
    const result = cached
      ? { ...cached, decidedBy: "cache" }
      : await runChain(chain, call, { log: context.log, signal: context.signal, tool: context.tool, ...(context.cwd !== undefined ? { cwd: context.cwd } : {}) });
    const technical = "technical" in result && result.technical === true;
    if (!cached) {
      // a failed review is not a judgement: it is not remembered, so the next try asks again
      if (result.decidedBy === "reviewer" && !technical) state.verdicts.set(key, { kind: result.kind, reason: result.reason });
      record(state, result.kind === "deny");
    }
    const usage = "usage" in result ? result.usage : undefined;
    await writeRecord(context.log, call, result, technical, Date.now() - started, usage);
    emit({ kind: "review", tool: call.name, callId: call.id, outcome: result.kind, decidedBy: result.decidedBy, reason: result.reason, ...(technical ? { technical } : {}) });

    if (result.kind === "allow") return { kind: "allow" };
    if (technical)
      return { kind: "deny", reason: `${result.reason} This was a failure of the review, not a decision about the action. Trying the same action again is fine; if it keeps failing, tell the user.` };
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
