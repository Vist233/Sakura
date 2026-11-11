// Live check of cancel-then-ask, steering while a tool runs, a reviewer decision and /status.
// usage: node --disable-warning=ExperimentalWarning test/live/rerun.ts PROVIDER ROOT
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VirtualTerminal } from "../support/vt.ts";

const [provider, rootArgument] = process.argv.slice(2);
if (!provider || !rootArgument) throw new Error("usage: rerun.ts PROVIDER ROOT");
const root = resolve(rootArgument);
const work = join(root, "work");
mkdirSync(work, { recursive: true });
const driver = new URL("../pty/drive.py", import.meta.url).pathname;
const binary = new URL("../../bin/sakuracode.mjs", import.meta.url).pathname;
const steps = [
  { expect: "sakuracode" },
  { send: "Write a very long essay of 3000 words about the history of computers.\r" },
  { expect: "Working \\(", timeout: 30 },
  { sleep: 4 },
  { send: "\u001b" },
  { expect: "Run cancelled", timeout: 30 },
  { send: "What is 2+2? Answer with just the number.\r" },
  { expect: "• 4", timeout: 90 },
  { sleep: 3 },
  { send: "Run the shell command `sleep 8` and then tell me it is finished.\r" },
  { expect: "Working \\(", timeout: 30 },
  { sleep: 3 },
  { send: "Also include the word STEERED in your final answer.\r" },
  { expect: "steering: Also include", timeout: 20 },
  { expect: "STEERED", timeout: 120 },
  { sleep: 3 },
  { send: "Create a file made.txt containing hello.\r" },
  { expect: "write made.txt", timeout: 90 },
  { sleep: 8 },
  { send: "/status\r" },
  { expect: "State", timeout: 30 },
  { send: "\u0003" },
  { sleep: 0.4 },
  { send: "\u0003" },
  { expect: "Resume it with", timeout: 60 },
];
writeFileSync(join(root, "steps.json"), JSON.stringify(steps));
const result = spawnSync("python3", ["-I", driver, join(root, "steps.json"), join(root, "out.bin"), "100", "60", work, "--", process.execPath, "--disable-warning=ExperimentalWarning", binary, "--provider", provider], {
  env: { PATH: process.env.PATH ?? "", HOME: root, TERM: "xterm-256color", SAKURA_HOME: join(root, "home"), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "", OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
  encoding: "utf8",
  timeout: 900_000,
});
const terminal = new VirtualTerminal(100);
terminal.write(readFileSync(join(root, "out.bin")).toString("utf8"));
console.log(`driver status ${result.status}\n${terminal.text()}`);
