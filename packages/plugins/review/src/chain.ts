import { describeFailure } from "@sakura/kernel";
import type { Tool, ToolCall } from "@sakura/kernel";
import type { Log } from "@sakura/kernel";

export type Verdict = { kind: "allow"; reason?: string } | { kind: "deny"; reason: string } | { kind: "pass" };

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
      };
    }
    if (verdict.kind === "allow") return { kind: "allow", reason: verdict.reason ?? "allowed", decidedBy: authorizer.name };
    if (verdict.kind === "deny") return { kind: "deny", reason: verdict.reason, decidedBy: authorizer.name };
  }
  return { kind: "deny", reason: "No safety check approved this action.", decidedBy: "end-of-chain" };
}
