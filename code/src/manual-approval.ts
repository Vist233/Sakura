import type { ToolCall } from "./framework.ts";

export type ApprovalDecision = "allow" | "reject" | "cancel";
export type RequestApproval = (call: ToolCall, signal: AbortSignal) => Promise<ApprovalDecision>;

/** Keep one approval visible at a time, even when the agent asks to run several reads in parallel. */
export function manualAuthorizer(request?: RequestApproval) {
  let pending = Promise.resolve();
  return {
    name: "human",
    review(call: ToolCall, { signal }: { signal: AbortSignal }) {
      const decision = pending.then(async () => {
        if (signal.aborted) return { kind: "deny", reason: "Approval cancelled." } as const;
        if (!request) return { kind: "deny", reason: "Manual approval is unavailable in this client." } as const;
        const answer = await request(call, signal);
        if (signal.aborted || answer === "cancel") return { kind: "deny", reason: "Approval cancelled." } as const;
        if (answer === "allow") return { kind: "allow", reason: "Approved by the user." } as const;
        return { kind: "deny", reason: "Rejected by the user." } as const;
      });
      pending = decision.then(
        () => undefined,
        () => undefined,
      );
      return decision;
    },
  };
}
