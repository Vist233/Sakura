import { describe, expect, it } from "vitest";
import { createFauxClient } from "@sakura/testing";
import { createMemoryLog } from "@sakura/session";
import { reviewPlugin } from "../src/index.ts";

// By default a read-only command that points outside the working directory goes to the reviewer. An application that has no notion of a working
// directory (the agent works on the whole machine) turns that off with `directoryRules: false`; the other hard rules stay.
const verdict = (risk: string, auth: string, outcome: string) => ({ text: JSON.stringify({ risk_level: risk, user_authorization: auth, outcome, rationale: "r" }) });
const context = () => ({ log: createMemoryLog(), signal: new AbortController().signal, tool: () => undefined, cwd: "/work/project" });
const bash = (command: string) => ({ id: "c", name: "bash", args: { command } });

async function review(command: string, options: { directoryRules?: boolean }) {
  const reviewer = createFauxClient([verdict("low", "high", "allow")]);
  const plugin = reviewPlugin({ llm: reviewer, ...options });
  const result = await plugin.authorize(bash(command), context());
  return { result, asked: reviewer.requests.length };
}

describe("directoryRules", () => {
  for (const command of ["ls /etc", "cat /usr/share/dict/words", "ls ../other", "ls ~/projects", "grep -r foo /var/log"]) {
    it(`by default "${command}" goes to the reviewer`, async () => {
      expect((await review(command, {})).asked).toBe(1);
    });
    it(`with directoryRules: false "${command}" is allowed by the hard rules, without the reviewer`, async () => {
      const { result, asked } = await review(command, { directoryRules: false });
      expect(result.kind).toBe("allow");
      expect(asked).toBe(0);
    });
  }

  it("the other hard rules stay: a command with an expansion still goes to the reviewer", async () => {
    expect((await review("ls $(pwd)/x", { directoryRules: false })).asked).toBe(1);
    expect((await review("ls `pwd`", { directoryRules: false })).asked).toBe(1);
  });

  it("credentials are still sensitive, and a command that writes still needs a review", async () => {
    expect((await review("cat ~/.ssh/id_rsa", { directoryRules: false })).asked).toBe(1);
    expect((await review("touch /tmp/x", { directoryRules: false })).asked).toBe(1);
  });

  it("the catastrophic rules are not affected", async () => {
    const { result, asked } = await review("rm -rf /", { directoryRules: false });
    expect(result.kind).toBe("deny");
    expect(asked).toBe(0);
  });
});
