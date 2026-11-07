import type { PauseReason, Plugin, ProviderErrorKind, UsageTotals } from "@sakura/kernel";
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
  /** Stop a single run that has been going this long. */
  maxRunSeconds?: number;
}

export interface LimitsOptions extends Budget {
  prices?: Prices;
  /** Provider errors that pause the run instead of ending it. Default: quota and rate_limit. */
  pauseOn?: ProviderErrorKind[];
  now?: () => number;
}

export interface LimitsPlugin extends Plugin {
  /** Change the budget, for example before running a paused session again. */
  update(budget: Budget): void;
}

const totalTokens = (totals: UsageTotals): number => totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

/**
 * Spending limits for a session. Unlimited unless configured. Usage is read from the log by the kernel,
 * so limits keep counting across restarts.
 */
export function limitsPlugin(options: LimitsOptions = {}): LimitsPlugin {
  const budget: Budget = { ...options };
  const now = options.now ?? Date.now;
  const pauseOn = new Set<ProviderErrorKind>(options.pauseOn ?? ["quota", "rate_limit"]);
  let runStartedAt = now();

  return {
    name: "limits",
    compensates: "models do not know what they cost",
    update: (next) => Object.assign(budget, next),
    setup(api) {
      api.on("event", (event) => {
        if (event.type === "run_start") runStartedAt = now();
      });
      api.on("turn.end", ({ totals }) => {
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
