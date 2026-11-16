import type { Message, PauseReason, Plugin, ProviderErrorKind, UsageTotals } from "@sakura/kernel";
import { costOf } from "./cost.ts";
import type { Prices } from "./cost.ts";

export type { Prices } from "./cost.ts";

export interface Budget {
  /** Stop after this many model replies in the session. */
  maxTurns?: number;
  /** Stop after this many tokens in the session (input, output and cache together). */
  maxTokens?: number;
  /** Stop after this much spend in the session; needs `prices`. */
  maxCostUsd?: number;
  /**
   * Stop a single run that has been going this long. This is checked at the end of each turn, not during one: a turn that is under way (a model
   * request, a command) finishes first, and what stops those is their own limits. So it is a budget, not a hard deadline.
   */
  maxRunSeconds?: number;
}

export interface LimitsOptions extends Budget {
  prices?: Prices;
  /** Provider errors that pause the run instead of ending it. Default: quota and rate_limit. */
  pauseOn?: ProviderErrorKind[];
  /**
   * Tell the model where it stands against the limits that are set: a short note at the end of the conversation in every request ("12 of 15 minutes used;
   * turn 31 of 40"), and, when any limit is `warnAt` used up, a request to finish. The note is not kept in the log. Default true; it says nothing when no limit is set.
   */
  notes?: boolean;
  /** The share of a limit (0 to 1) at which the model is asked to finish: make sure the result passes, verify it, then stop. Default 0.8. */
  warnAt?: number;
  now?: () => number;
}

export interface LimitsPlugin extends Plugin {
  /** Change the budget, for example before running a paused session again. */
  update(budget: Budget): void;
  /** Milliseconds left of this run's `maxRunSeconds` (never below 0), or undefined when no time limit is set. For whoever has to size a wait to what remains. */
  remainingMs(): number | undefined;
}

const totalTokens = (totals: UsageTotals): number => totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

interface Measure {
  label: string;
  used: number;
  max: number;
}

const minutes = (seconds: number): string => `${Math.round((seconds / 60) * 10) / 10}`;
const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** One line for the model: what is used of each limit that is set, and the request to finish when one is nearly used up. */
function describeLimits(measures: readonly Measure[], warnAt: number): string | undefined {
  if (measures.length === 0) return undefined;
  const text = measures.map((measure) => measure.label).join("; ");
  const near = measures.some((measure) => measure.used >= measure.max * warnAt);
  return `[Limits: ${text}.${near ? " You are close to a limit: finish now. Make sure the result passes its checks, verify it with a command, then stop." : ""}]`;
}

/**
 * Spending limits for a session. Unlimited unless configured. Usage is read from the log by the kernel,
 * so limits keep counting across restarts.
 */
export function limitsPlugin(options: LimitsOptions = {}): LimitsPlugin {
  const budget: Budget = { ...options };
  const now = options.now ?? Date.now;
  const pauseOn = new Set<ProviderErrorKind>(options.pauseOn ?? ["quota", "rate_limit"]);
  const warnAt = options.warnAt ?? 0.8;
  let runStartedAt = now();
  let lastTotals: UsageTotals | undefined;

  /** What is used of each limit that is set. The reply counts are those at the end of the last turn; time is read now. */
  const measures = (): Measure[] => {
    const list: Measure[] = [];
    if (budget.maxRunSeconds !== undefined) {
      const used = (now() - runStartedAt) / 1000;
      list.push({ label: `${minutes(used)} of ${minutes(budget.maxRunSeconds)} minutes used`, used, max: budget.maxRunSeconds });
    }
    if (lastTotals) {
      if (budget.maxTurns !== undefined) list.push({ label: `turn ${lastTotals.turns + 1} of ${budget.maxTurns}`, used: lastTotals.turns + 1, max: budget.maxTurns });
      if (budget.maxTokens !== undefined) list.push({ label: `${totalTokens(lastTotals)} of ${budget.maxTokens} tokens used`, used: totalTokens(lastTotals), max: budget.maxTokens });
      if (budget.maxCostUsd !== undefined && options.prices !== undefined) {
        const used = costOf(lastTotals, options.prices);
        list.push({ label: `${money(used)} of ${money(budget.maxCostUsd)} spent`, used, max: budget.maxCostUsd });
      }
    }
    return list;
  };

  return {
    name: "limits",
    compensates: "models do not know what they cost",
    update: (next) => Object.assign(budget, next),
    remainingMs: () => (budget.maxRunSeconds === undefined ? undefined : Math.max(0, budget.maxRunSeconds * 1000 - (now() - runStartedAt))),
    setup(api) {
      api.on("event", (event) => {
        if (event.type === "run_start") runStartedAt = now();
      });
      if (options.notes !== false) {
        api.on("context", ({ messages }) => {
          const note = describeLimits(measures(), warnAt);
          if (note === undefined) return;
          const message: Message = { role: "user", content: [{ type: "text", text: note }], ts: now() };
          return [...messages, message];
        });
      }
      api.on("turn.end", ({ totals }) => {
        lastTotals = totals;
        const exceeded =
          (budget.maxTurns !== undefined && totals.turns >= budget.maxTurns) ||
          (budget.maxTokens !== undefined && totalTokens(totals) >= budget.maxTokens) ||
          (budget.maxCostUsd !== undefined && options.prices !== undefined && costOf(totals, options.prices) >= budget.maxCostUsd) ||
          (budget.maxRunSeconds !== undefined && now() - runStartedAt >= budget.maxRunSeconds * 1000);
        return exceeded ? { pause: "budget" as PauseReason } : undefined;
      });
      api.on("error", (error) => (pauseOn.has(error.kind) ? { pause: "quota" as PauseReason } : undefined));
    },
  };
}
