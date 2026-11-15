import type { ApprovalDecision, RequestApproval } from "../manual-approval.ts";
import type { KeyEvent } from "./keys.ts";

export function terminalApproval(print: (lines: string[]) => void, cancelRun: () => void) {
  let settle: ((decision: ApprovalDecision) => void) | undefined;

  const request: RequestApproval = async (call, signal) => {
    if (signal.aborted) return "cancel";
    const args = JSON.stringify(call.args, null, 2) ?? "null";
    const escapeControls = (value: string) => value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
    return new Promise((resolve) => {
      const abort = () => settle?.("cancel");
      settle = (decision) => {
        signal.removeEventListener("abort", abort);
        settle = undefined;
        resolve(decision);
      };
      signal.addEventListener("abort", abort, { once: true });
      print([`Manual approval for ${escapeControls(call.name)}`, ...escapeControls(args).split("\n"), "[y] Allow once  [n] Reject  [Esc] Cancel turn"]);
    });
  };

  return {
    request,
    onKey(key: KeyEvent): boolean {
      if (!settle) return false;
      if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
        cancelRun();
        settle?.("cancel");
      } else if (key.name === "char" && !key.ctrl && !key.alt) {
        if (key.text === "y") settle("allow");
        else if (key.text === "n") settle("reject");
      }
      return true;
    },
  };
}
