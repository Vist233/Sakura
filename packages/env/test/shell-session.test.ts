// The persistent shell: the protocol against a real local bash, and against a transport that misbehaves.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localShellTransport } from "../src/shell-child.ts";
import { createShellSession, SHELL_LOST_NOTE, SHELL_STUCK_NOTE, signalChildrenCommand } from "../src/shell-session.ts";
import type { ShellProcess, ShellSession, ShellTransport } from "../src/shell-session.ts";

let dir: string;
let session: ShellSession;
const open = (extra: { interruptGraceMs?: number } = {}) => (session = createShellSession(localShellTransport(), { cwd: dir, ...extra }));

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "shell-")));
  open();
});
afterEach(async () => {
  await session.close();
  await rm(dir, { recursive: true, force: true });
});

describe("state carries over", () => {
  it("the directory, the variables and the functions", async () => {
    await session.run('mkdir sub && cd sub && export GREETING=hello && greet() { echo "$GREETING from $(basename $PWD)"; }');
    expect((await session.run("greet")).output).toBe("hello from sub\n");
    expect((await session.run("pwd")).output).toBe(`${dir}/sub\n`);
  });

  it("a virtual environment style source", async () => {
    await session.run("printf 'export FROM_FILE=yes\\n' > env.sh && source env.sh");
    expect((await session.run("echo $FROM_FILE")).output).toBe("yes\n");
  });

  it("a directory that does not exist fails the command with bash's words and does not run it", async () => {
    const result = await session.run("echo ran", { cwd: join(dir, "missing") });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No such file or directory");
    expect(result.output).not.toContain("ran");
  });

  it("the cwd option moves the shell and leaves it there", async () => {
    await session.run("mkdir other");
    expect((await session.run("pwd", { cwd: join(dir, "other") })).output).toBe(`${dir}/other\n`);
    expect((await session.run("pwd")).output).toBe(`${dir}/other\n`);
  });
});

describe("what a command returns", () => {
  it("the exit code, and errors mixed into the output in order", async () => {
    const result = await session.run("echo out; echo err >&2; echo out2; exit_code() { return 7; }; exit_code");
    expect(result).toEqual({ exitCode: 7, output: "out\nerr\nout2\n", timedOut: false });
  });

  it("an output without a final newline is kept as it is", async () => {
    expect((await session.run("printf abc")).output).toBe("abc");
    expect((await session.run("printf ''")).output).toBe("");
  });

  it("multi-line scripts, quotes and heredocs", async () => {
    const result = await session.run("cat <<'EOF'\nit's \"quoted\" $HOME\nEOF\nfor i in 1 2; do echo $i; done");
    expect(result.output).toBe('it\'s "quoted" $HOME\n1\n2\n');
  });

  it("a command that reads its input gets nothing and does not eat the next command", async () => {
    expect((await session.run("cat")).output).toBe("");
    expect((await session.run("echo next")).output).toBe("next\n");
  });

  it("a line that looks like the marker is only output", async () => {
    const result = await session.run("echo '__SAKURA_END_deadbeef_0__'; echo '__SAKURA_READY_1__'");
    expect(result.output).toBe("__SAKURA_END_deadbeef_0__\n__SAKURA_READY_1__\n");
  });

  it("an output larger than what is kept: only its end comes back, in linear time and bounded memory", async () => {
    const started = Date.now();
    const result = await session.run("head -c 25000000 /dev/zero | tr '\\0' a; echo; echo last-line");
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(20_000_000);
    expect(result.output.endsWith("last-line\n")).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect((await session.run("echo next")).output).toBe("next\n");
  }, 60_000);

  it("multi-byte text and a lot of output", async () => {
    expect((await session.run("echo 'héllo 世界 🌸'")).output).toBe("héllo 世界 🌸\n");
    const big = await session.run("head -c 3000000 /dev/zero | tr '\\0' 'x'; echo");
    expect(big.output.length).toBe(3_000_001);
  });
});

describe("one command at a time", () => {
  it("commands asked together run in the order they were asked", async () => {
    const results = await Promise.all([session.run("sleep 0.2; echo a"), session.run("echo b"), session.run("echo c")]);
    expect(results.map((result) => result.output)).toEqual(["a\n", "b\n", "c\n"]);
  });
});

describe("a command that takes too long", () => {
  it("is interrupted, the output so far is returned, and the shell keeps its state", async () => {
    await session.run("cd /tmp && export KEPT=1");
    const started = Date.now();
    const result = await session.run("echo before; sleep 30", { timeoutMs: 400 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("before\n");
    expect(result.output).toContain("Still running after 0.4 seconds: interrupted");
    expect((await session.run("echo $KEPT; pwd")).output).toBe(`1\n${await realpath("/tmp")}\n`);
  });

  it("the signal does the same, and a signal that was already given runs nothing", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await session.run("echo go; sleep 30", { signal: controller.signal });
    expect(result.output).toContain("go\n");
    expect(result.output).toContain("[Interrupted.]");
    expect((await session.run("echo still here")).output).toBe("still here\n");
    const done = new AbortController();
    done.abort();
    expect(await session.run("echo never", { signal: done.signal })).toEqual({ exitCode: null, output: "", timedOut: false });
  });

  it("one that ignores the interrupt is stopped with the shell, and a new shell is started with the loss said", async () => {
    open({ interruptGraceMs: 300 });
    await session.run("export GONE=1");
    const result = await session.run("bash -c 'trap \"\" INT; sleep 30'", { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain(SHELL_STUCK_NOTE);
    const next = await session.run('echo "[$GONE]"');
    expect(next.output).toBe("[]\n");
  });
});

describe("a shell that ends", () => {
  it("`exit` ends it: the result says so and the next command gets a new shell in the starting directory", async () => {
    await session.run("cd /tmp");
    const result = await session.run("echo bye; exit 3");
    expect(result.exitCode).toBe(3);
    expect(result.output).toBe(`bye\n${SHELL_LOST_NOTE}`);
    expect((await session.run("pwd")).output).toBe(`${dir}\n`);
  });

  it("a shell killed from outside is the same", async () => {
    const result = await session.run("kill -9 $$");
    expect(result.output).toContain(SHELL_LOST_NOTE);
    expect((await session.run("echo ok")).output).toBe("ok\n");
  });

  it("close stops the shell and what it started, and later commands are refused", async () => {
    await session.run("sleep 60 & echo started");
    await session.close();
    expect(await session.run("echo x")).toMatchObject({ exitCode: null, output: "the shell session is closed" });
  });
});

describe("a transport that misbehaves", () => {
  /** A transport whose shell is a script: `reply(written)` gives what the shell prints for what it was sent. */
  function scripted(reply: (written: string, emit: (text: string) => void, end: (error?: Error) => void) => void): ShellTransport {
    return {
      start(): ShellProcess {
        let data: (text: string) => void = () => undefined;
        let exit: (info: { error?: Error }) => void = () => undefined;
        const emit = (text: string) => queueMicrotask(() => data(text));
        return {
          write: (text) => reply(text, emit, (error) => exit(error ? { error } : {})),
          onData: (listener) => {
            data = listener;
          },
          onExit: (listener) => {
            exit = listener;
          },
          kill: () => exit({}),
        };
      },
      interrupt: async () => undefined,
    };
  }

  it("a shell that never says it is ready is reported, not waited for", async () => {
    const stuck = createShellSession(
      scripted(() => undefined),
      { cwd: "/", startTimeoutMs: 100 },
    );
    const result = await stuck.run("echo hi");
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("the shell could not be started");
    expect(result.output).toContain("did not start within 0.1 seconds");
  });

  it("a lost connection while a command runs rejects with that error, and the next command starts again", async () => {
    let starts = 0;
    const lost = new Error("the connection is gone");
    const transport: ShellTransport = {
      start(cwd) {
        starts++;
        const mine = starts;
        return scripted((written, emit, end) => {
          if (written.includes("__SAKURA_READY_")) return emit("__SAKURA_READY_42__");
          if (mine === 1) return end(lost);
          emit(`ok${/__SAKURA_END_(\w+)_/.exec(written)?.[0] ?? ""}0__`);
        }).start(cwd);
      },
      interrupt: async () => undefined,
    };
    const remote = createShellSession(transport, { cwd: "/" });
    await expect(remote.run("echo one")).rejects.toBe(lost);
    expect((await remote.run("echo two")).exitCode).toBe(0);
    expect(starts).toBe(2);
  });

  it("the marker split over two chunks is still found", async () => {
    const transport = scripted((written, emit) => {
      if (written.includes("__SAKURA_READY_")) return emit("__SAKURA_READY_7__");
      const id = /__SAKURA_END_(\w+)_%d__/.exec(written)![1];
      emit(`partial __SAKURA_E`);
      emit(`ND_${id}_`);
      emit("5__");
    });
    const result = await createShellSession(transport, { cwd: "/" }).run("x");
    expect(result).toEqual({ exitCode: 5, output: "partial ", timedOut: false });
  });
});

describe("signalChildrenCommand", () => {
  it("is a valid command that does nothing to a pid without children, with and without pkill", async () => {
    for (const signal of ["INT", "KILL"] as const) {
      const command = signalChildrenCommand(99_999_999, signal);
      expect((await session.run(command)).exitCode).toBe(0);
      expect((await session.run(`PATH=/nonexistent /bin/bash -c ${JSON.stringify(command)}`)).exitCode).toBe(0); // no pkill on the path: the /proc loop is parsed and run
    }
  });
});
