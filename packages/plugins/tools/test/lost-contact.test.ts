// What the bash tool does when the environment loses contact with a command (a remote machine that stopped answering): the model is told what happened
// and where the output is, nothing says the command ended or was killed, and nothing is left running or unhandled.
import { describe, expect, it, vi } from "vitest";
import type { Environment, ExecResult, ProcessHandle, ToolContext } from "@sakura/kernel";
import { createBashTool } from "../src/builtin/bash.ts";
import { textOf } from "./helpers.ts";

/** An environment whose commands never finish on their own; the test says when contact is lost. */
function environment() {
  let lose!: (message: string) => void;
  let finish!: (result: ExecResult) => void;
  const waiting = new Promise<ExecResult>((resolve, reject) => {
    lose = (message) => reject(new Error(message));
    finish = resolve;
  });
  waiting.catch(() => undefined);
  const handle: ProcessHandle = { pid: 4242, outputFile: "/remote/out.log", wait: () => waiting, kill: () => undefined, finished: false };
  const env = { cwd: "/work", spawn: () => handle, readFile: async () => new TextEncoder().encode("partial output\n") } as unknown as Environment;
  return { env, lose, finish };
}
const context = (env: Environment, watch: ToolContext["watch"] = () => () => undefined): ToolContext => ({
  env,
  signal: new AbortController().signal,
  callId: "c",
  log: undefined as never,
  notify: () => undefined,
  watch,
});

describe("bash: contact with the command is lost", () => {
  it("while the model waits for it: an error result with the environment's own words, not 'killed' and not an exit code", async () => {
    const { env, lose } = environment();
    const pending = createBashTool().execute({ command: "make" }, context(env));
    lose("The connection to the remote machine was lost (Broken pipe). The command may still be running; its output is being written to /remote/out.log.");
    const result = await pending;
    expect(result.isError).toBe(true);
    const shown = textOf(result.content);
    expect(shown).toContain("lost");
    expect(shown).toContain("/remote/out.log");
    expect(shown).not.toContain("killed");
    expect(shown).not.toContain("exited with code");
  });

  it("leaves no timer behind, so a process that is done can end", async () => {
    vi.useFakeTimers();
    try {
      const { env, lose } = environment();
      const pending = createBashTool({ softTimeoutMs: 60_000 }).execute({ command: "make", timeout: 600 }, context(env));
      expect(vi.getTimerCount()).toBe(2); // the soft limit and the time limit the model asked for
      lose("gone");
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("after the command went to the background: the end is reported as 'could not be followed', with the reason, and nothing is unhandled", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const { env, lose } = environment();
    const endings: string[] = [];
    const result = await createBashTool({ softTimeoutMs: 50 }).execute(
      { command: "make" },
      context(env, () => (text) => endings.push(text)),
    );
    expect(textOf(result.content)).toContain("moved to the background");
    lose("The connection to the remote machine was lost (Broken pipe).");
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.removeListener("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
    expect(endings).toHaveLength(1);
    expect(endings[0]).toContain("could not be followed to its end");
    expect(endings[0]).toContain("Broken pipe");
    expect(endings[0]).toContain("4242");
  });

  it("a command that finishes after all is reported as before", async () => {
    const { env, finish } = environment();
    const pending = createBashTool().execute({ command: "make" }, context(env));
    finish({ exitCode: 0, output: "built\n", timedOut: false });
    expect(textOf((await pending).content)).toBe("built");
  });

  it("with the hard timeout set, losing contact still ends the call at once", async () => {
    const { env, lose } = environment();
    const started = Date.now();
    const pending = createBashTool().execute({ command: "make", timeout: 30 }, context(env));
    lose("gone");
    expect((await pending).isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
