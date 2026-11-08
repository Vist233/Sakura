import type { LogEntry, Message } from "./types.ts";

export interface CompactionConfig {
  /** Compact when the context is within this many tokens of the model's window. */
  reserveTokens: number;
  /**
   * Compact when the free part of the window is smaller than this share of it (default 0.17, so at 83% full). The larger of this and
   * `reserveTokens` applies. Left out or not a number between 0 and 1, it counts as 0.
   */
  reserveFraction?: number;
  /** Roughly how many recent tokens stay word for word after a compaction. */
  keepRecentTokens: number;
}

export const defaultCompaction: CompactionConfig = { reserveTokens: 16_384, reserveFraction: 0.17, keepRecentTokens: 20_000 };

/** A rough token count: four characters per token, a flat cost for images. */
export function estimateTokens(message: Message): number {
  let characters = 0;
  for (const part of message.content) {
    if (part.type === "text") characters += part.text.length;
    else if (part.type === "tool_call") characters += part.name.length + JSON.stringify(part.args ?? "").length;
    else if (part.type === "image") characters += 4000;
    else characters += JSON.stringify(part.data ?? "").length;
  }
  return Math.ceil(characters / 4);
}

/** Tokens in the context now: the last reported usage plus an estimate for what came after it. */
export function contextTokens(messages: readonly Message[]): number {
  let lastUsage = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.usage) {
      lastUsage = index;
      break;
    }
  }
  const reported = lastUsage >= 0 ? (messages[lastUsage]?.usage ?? undefined) : undefined;
  const base = reported ? reported.input + reported.output + reported.cacheRead + reported.cacheWrite : 0;
  return messages.slice(lastUsage + 1).reduce((sum, message) => sum + estimateTokens(message), base);
}

/** How many tokens of the window must stay free: the larger of the fixed amount and the share of the window. */
export function reservedTokens(contextWindow: number, config: CompactionConfig): number {
  const share = config.reserveFraction;
  const fraction = typeof share === "number" && share > 0 && share < 1 ? share : 0;
  return Math.max(config.reserveTokens, Math.ceil(contextWindow * fraction));
}

export function shouldCompact(messages: readonly Message[], contextWindow: number, config: CompactionConfig): boolean {
  return messages.length > 1 && contextTokens(messages) > contextWindow - reservedTokens(contextWindow, config);
}

export interface CompactionPlan {
  /** Id of the first entry that stays word for word. */
  firstKeptEntryId: string;
  /** True when the cut falls inside a turn (no user message boundary was available). */
  splitTurn: boolean;
}

/**
 * Chooses where to cut. History before the cut is summarised, the rest stays. The cut is placed at a user
 * message where possible; it is never placed on a tool result, so a call and its results stay together.
 * Returns undefined when there is nothing worth summarising.
 */
export function planCompaction(branch: readonly LogEntry[], config: CompactionConfig): CompactionPlan | undefined {
  const start = (() => {
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type === "compaction") {
        const kept = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
        return kept === -1 ? index + 1 : kept;
      }
    }
    return 0;
  })();

  const candidates: Array<{ index: number; tokensAfter: number; role: string }> = [];
  let running = 0;
  for (let index = branch.length - 1; index >= start; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    running += estimateTokens(entry.message);
    if (entry.message.role === "user" || entry.message.role === "assistant") {
      candidates.push({ index, tokensAfter: running, role: entry.message.role });
    }
  }
  // candidates run from newest to oldest; the first one with enough tokens after it is where we cut,
  // but never at the very first entry (that would summarise nothing)
  const firstIndex = branch.findIndex((entry, index) => index >= start && entry.type === "message");
  const usable = candidates.filter((candidate) => candidate.index > firstIndex);
  const enough = usable.filter((candidate) => candidate.tokensAfter >= config.keepRecentTokens);
  const pool = enough.length > 0 ? enough : usable;
  if (pool.length === 0) return undefined;

  // prefer the newest user boundary among the candidates that keep at least keepRecentTokens; otherwise
  // the newest candidate that keeps enough; if only assistant boundaries exist the turn is split
  const byAge = [...pool].sort((a, b) => b.index - a.index);
  const userCut = byAge.find((candidate) => candidate.role === "user");
  const chosen = userCut ?? byAge[0];
  if (!chosen) return undefined;
  const entry = branch[chosen.index];
  if (!entry) return undefined;
  return { firstKeptEntryId: entry.id, splitTurn: chosen.role !== "user" };
}
