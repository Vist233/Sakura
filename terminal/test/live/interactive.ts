// A live check of the interactive session against a real provider, driven through a pseudo-terminal.
// usage: node --disable-warning=ExperimentalWarning test/live/interactive.ts PROVIDER WORKDIR [SAKURA_HOME]
// It costs a few model calls. The screens it prints are what a user would have seen; keys are never printed.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VirtualTerminal } from "../support/vt.ts";

const [provider, workdirArgument, homeArgument] = process.argv.slice(2);
if (!provider || !workdirArgument) throw new Error("usage: interactive.ts PROVIDER WORKDIR [SAKURA_HOME]");
const workdir = resolve(workdirArgument);
const home = resolve(homeArgument ?? join(workdir, "..", "home"));
mkdirSync(workdir, { recursive: true });
const driver = new URL("../pty/drive.py", import.meta.url).pathname;
const binary = new URL("../../bin/sakura-terminal.mjs", import.meta.url).pathname;

function drive(name: string, steps: unknown[], args: string[]): { status: number | null; screen: string } {
  const stepsFile = join(workdir, `${name}.steps.json`);
  const outputFile = join(workdir, `${name}.out.bin`);
  writeFileSync(stepsFile, JSON.stringify(steps));
  const result = spawnSync("python3", ["-I", driver, stepsFile, outputFile, "100", "40", workdir, "--", process.execPath, "--disable-warning=ExperimentalWarning", binary, "-p", provider!, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, TERM: "xterm-256color", SAKURA_HOME: home, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "", OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
    encoding: "utf8",
    timeout: 600_000,
  });
  const terminal = new VirtualTerminal(100);
  terminal.write(readFileSync(outputFile).toString("utf8"));
  return { status: result.status, screen: terminal.text() };
}

const first = drive(
  "first",
  [
    { expect: "Sakura Terminal" },
    { send: "Create hello.py that prints the numbers 1 to 5, run it with python3, and tell me the output in a Markdown list.\r" },
    { expect: "Resume it with|• .*1", timeout: 120 },
    { sleep: 6 },
    { send: "/status\r" },
    { expect: "State", timeout: 20 },
    { send: "/compact\r" },
    { expect: "compacted|Nothing worth", timeout: 120 },
    { send: "Write a very long essay of 3000 words about the history of computers.\r" },
    { expect: "Working \\(", timeout: 30 },
    { sleep: 4 },
    { send: "\u001b" },
    { expect: "Run cancelled", timeout: 30 },
    { send: "\u0003" },
    { sleep: 0.4 },
    { send: "\u0003" },
    { expect: "Resume it with", timeout: 30 },
  ],
  [],
);
console.log(`### first session (driver status ${first.status})\n${first.screen}\n`);

const second = drive("second", [{ expect: "Sakura Terminal" }, { sleep: 1 }, { send: "What was the file I asked you to create earlier? One sentence.\r" }, { sleep: 15 }, { send: "/status\r" }, { expect: "State", timeout: 60 }, { send: "\u0004" }, { expect: "Resume it with", timeout: 30 }], ["resume", "--last"]);
console.log(`### resumed session (driver status ${second.status})\n${second.screen}\n`);
