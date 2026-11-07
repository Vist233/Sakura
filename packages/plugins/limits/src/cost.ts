import type { UsageTotals } from "@sakura/kernel";

/** Prices in US dollars per million tokens. */
export interface Prices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function costOf(totals: UsageTotals, prices: Prices): number {
  return (totals.input * prices.input + totals.output * prices.output + totals.cacheRead * (prices.cacheRead ?? prices.input) + totals.cacheWrite * (prices.cacheWrite ?? prices.input)) / 1_000_000;
}
