import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createBashTool, softLimitFor } from "../src/builtin/bash.ts";
import { range, run, useSandbox } from "./helpers.ts";

const box = useSandbox();
const quick = (ms = 300) => createBashTool({ softTimeoutMs: ms });
const field = (text: string, name: string) => text.match(new RegExp(`${name}: (.+)`))?.[1]?.trim() ?? "";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("softLimitFor", () => {
  const cases: Array<[string, number]> = [
    ["echo hi", 120_000],
    ["sleep 10", 130_000],
    ["sleep 0.5; echo x", 120_500],
    ["  sleep 60 && make", 180_000],
    ["echo sleep 100", 120_000],
    ["sleeper 5", 120_000],
    ["sleep", 120_000],
    ["sleep abc", 120_000],
  ];
  for (const [command, expected] of cases) {
    it(`${JSON.stringify(command)} gets ${expected} ms`, () => {
      expect(softLimitFor(command, 120_000)).toBe(expected);
    });
  }
});

describe("moving a long command to the background", () => {
  for (const variant of range(8)) {
    it(`tells the agent the pid, the output file and how to stop it (variant ${variant})`, async () => {
      const result = await run(quick(250 + variant * 10), box.env, { command: "echo started; sleep 30" });
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain("moved to the background");
      const pid = Number(field(result.text, "pid"));
      const file = field(result.text, "Output is being written to");
      expect(pid).toBeGreaterThan(0);
      expect(result.text).toContain(`kill -- -${pid}`);
      expect(result.text).toContain("started");
      expect(alive(pid)).toBe(true);
      await run(quick(), box.env, { command: `kill -- -${pid}` });
      await new Promise((done) => setTimeout(done, 300));
      expect(alive(pid)).toBe(false);
      expect(await readFile(file, "utf8")).toContain("started");
    });
  }

  it("the output file keeps filling after the command moved to the background", async () => {
    const result = await run(quick(200), box.env, { command: "echo one; sleep 0.6; echo two" });
    const file = field(result.text, "Output is being written to");
    expect(await readFile(file, "utf8")).not.toContain("two");
    await new Promise((done) => setTimeout(done, 900));
    expect(await readFile(file, "utf8")).toContain("two");
  });

  it("a command that finishes before the soft limit stays in the foreground", async () => {
    const result = await run(quick(2000), box.env, { command: "echo fast" });
    expect(result.text).toBe("fast");
  });

  it("a command that starts with sleep N gets N extra seconds", async () => {
    const result = await run(quick(300), box.env, { command: "sleep 0.6; echo waited" });
    expect(result.text).toBe("waited");
  });

  it("a hard timeout still applies to a command that moved to the background", async () => {
    const result = await run(quick(200), box.env, { command: "true; sleep 30", timeout: 0.6 });
    const pid = Number(field(result.text, "pid"));
    expect(alive(pid)).toBe(true);
    await new Promise((done) => setTimeout(done, 1500));
    expect(alive(pid)).toBe(false);
  });

  it("dispose stops commands that are still running", async () => {
    const result = await run(quick(200), box.env, { command: "true; sleep 30" });
    const pid = Number(field(result.text, "pid"));
    expect(alive(pid)).toBe(true);
    await box.env.dispose();
    expect(alive(pid)).toBe(false);
  });

  it("the abort signal stops a command before it is moved", async () => {
    const controller = new AbortController();
    const pending = run(quick(5000), box.env, { command: "sleep 30" }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.isError).toBe(true);
  });

  it("points to the full output file when the output is cut", async () => {
    const result = await run(quick(5000), box.env, { command: "seq 1 5000" });
    const file = result.text.match(/Full output: (\S+?)\]/)?.[1];
    expect(file).toBeDefined();
    expect((await readFile(file!, "utf8")).trim().split("\n")).toHaveLength(5000);
  });

  for (const variant of range(8, 100)) {
    it(`output of a quick command is also saved to a file (variant ${variant})`, async () => {
      const handle = box.env.spawn(`echo saved${variant}`, {});
      const result = await handle.wait();
      expect(result.output.trim()).toBe(`saved${variant}`);
      expect(await readFile(handle.outputFile, "utf8")).toContain(`saved${variant}`);
      expect(handle.finished).toBe(true);
    });
  }
});

describe("telling the agent when a background command ends", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const [command, code] of [
    ["echo a; sleep 0.5; exit 0", 0],
    ["echo a; sleep 0.5; exit 3", 3],
    ["echo a; sleep 0.5; exit 127", 127],
  ] as Array<[string, number]>) {
    it(`notifies once, with the exit code ${code}, the pid and the output file`, async () => {
      const notices: string[] = [];
      const result = await run(quick(150), box.env, { command }, new AbortController().signal, (text) => notices.push(text));
      expect(notices).toEqual([]); // not while it is still running
      await wait(1200);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(`pid ${field(result.text, "pid")}`);
      expect(notices[0]).toContain(`finished with exit code ${code}`);
      expect(notices[0]).toContain(field(result.text, "Output is being written to"));
    });
  }
  it("does not notify for a command that finished in the foreground", async () => {
    const notices: string[] = [];
    await run(quick(2000), box.env, { command: "echo quick" }, new AbortController().signal, (text) => notices.push(text));
    await wait(300);
    expect(notices).toEqual([]);
  });
  it("says when the command was stopped", async () => {
    const notices: string[] = [];
    const result = await run(quick(150), box.env, { command: "true; sleep 30" }, new AbortController().signal, (text) => notices.push(text));
    await run(quick(), box.env, { command: `kill -- -${field(result.text, "pid")}` });
    await wait(1000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/was stopped|finished with exit code/);
  });
  it("says when a hard timeout stopped it", async () => {
    const notices: string[] = [];
    await run(quick(150), box.env, { command: "true; sleep 30", timeout: 0.5 }, new AbortController().signal, (text) => notices.push(text));
    await wait(2500);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("stopped by its timeout");
  });
});

describe("a background command is registered as pending work", () => {
  it("watch is called with the pid, and the end text is passed to it", async () => {
    const labels: string[] = [];
    const endings: string[] = [];
    const tool = quick(150);
    const result = await tool.execute(
      { command: "echo a; sleep 0.6; echo fin" },
      {
        env: box.env,
        signal: new AbortController().signal,
        callId: "w",
        log: undefined as never,
        notify: () => undefined,
        watch: (label) => {
          labels.push(label);
          return (text) => endings.push(text);
        },
      },
    );
    expect(JSON.stringify(result.content)).toContain("moved to the background");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^background command \(pid \d+\)$/);
    for (let tries = 0; tries < 40 && endings.length === 0; tries++) await new Promise((done) => setTimeout(done, 50));
    expect(endings).toHaveLength(1);
    expect(endings[0]).toContain("finished with exit code 0");
  });

  it("a command that ends in time registers nothing", async () => {
    const labels: string[] = [];
    await createBashTool({ softTimeoutMs: 5000 }).execute(
      { command: "echo quick" },
      {
        env: box.env,
        signal: new AbortController().signal,
        callId: "w",
        log: undefined as never,
        notify: () => undefined,
        watch: (label) => {
          labels.push(label);
          return () => undefined;
        },
      },
    );
    expect(labels).toEqual([]);
  });
});
