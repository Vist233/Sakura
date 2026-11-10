import { describeFailure } from "@sakura/kernel";
import type { Tool, ToolCall, Usage } from "@sakura/kernel";
import type { Log } from "@sakura/kernel";

/** What an authorizer may report besides its answer: the tokens it spent, and (for a refusal) that the check itself failed rather than judged. */
export type Verdict = { kind: "allow"; reason?: string; usage?: Usage } | { kind: "deny"; reason: string; technical?: true; usage?: Usage } | { kind: "pass" };

export interface ReviewContext {
  log: Log;
  signal: AbortSignal;
  tool(name: string): Tool | undefined;
  /** The working directory the call runs in. Paths that leave it are not waved through as read-only. */
  cwd?: string;
}

/** One link of the chain. `pass` hands the call to the next link. */
export interface Authorizer {
  name: string;
  review(call: ToolCall, context: ReviewContext): Promise<Verdict>;
}

export interface ChainResult {
  kind: "allow" | "deny";
  reason: string;
  decidedBy: string;
  /** True when the check itself failed (an unreadable answer, a timeout, an exception): the action was not judged, and trying it again is fine. */
  technical?: true;
  usage?: Usage;
}

/**
 * Asks each authorizer in turn. The first answer that is not `pass` wins. The chain always ends in an answer:
 * if every authorizer passes (or one fails), the call is denied. An empty chain is the caller's choice to skip review.
 */
export async function runChain(authorizers: readonly Authorizer[], call: ToolCall, context: ReviewContext): Promise<ChainResult> {
  for (const authorizer of authorizers) {
    let verdict: Verdict;
    try {
      verdict = await authorizer.review(call, context);
    } catch (error) {
      return {
        kind: "deny",
        reason: `The safety check '${authorizer.name}' failed (${describeFailure(error)}), so the action was not allowed.`,
        decidedBy: authorizer.name,
        technical: true,
      };
    }
    if (verdict.kind === "allow") return { kind: "allow", reason: verdict.reason ?? "allowed", decidedBy: authorizer.name, ...(verdict.usage ? { usage: verdict.usage } : {}) };
    if (verdict.kind === "deny") {
      return { kind: "deny", reason: verdict.reason, decidedBy: authorizer.name, ...(verdict.technical ? { technical: true as const } : {}), ...(verdict.usage ? { usage: verdict.usage } : {}) };
    }
  }
  return { kind: "deny", reason: "No safety check approved this action.", decidedBy: "end-of-chain" };
}
