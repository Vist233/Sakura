import type { ToolCall } from "../framework.ts";
import type { ApprovalDecision } from "../manual-approval.ts";
import { describeCall } from "./tool-mapping.ts";

export function permissionRequest(sessionId: string, call: ToolCall, cwd: string) {
  const card = describeCall(call, { cwd });
  return {
    sessionId,
    toolCall: { ...card, rawInput: call.args, toolCallId: call.id, name: call.name, status: "pending" as const },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ],
  };
}

export function permissionDecision(outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }): ApprovalDecision {
  if (outcome.outcome === "cancelled") return "cancel";
  return outcome.optionId === "allow-once" ? "allow" : "reject";
}
