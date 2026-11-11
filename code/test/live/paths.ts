// A live check of the paths that the offline tests cover only with a scripted model: /goal, !cmd, @file, /permissions,
// a review denial, /fork, /undo, /rename, a background command and /init. Costs a few dozen model calls.
// usage: node --disable-warning=ExperimentalWarning test/live/paths.ts PROVIDER ROOT
// ROOT/parent/work is the working directory; HOME is ROOT, holding only made-up startup files, so the "tidy up" request below can do no harm.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VirtualTerminal } from "../support/vt.ts";

const [provider, rootArgument] = process.argv.slice(2);
if (!provider || !rootArgument) throw new Error("usage: paths.ts PROVIDER ROOT");
const root = resolve(rootArgument);
const parent = join(root, "parent");
const work = join(parent, "work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "note.txt"), "The deploy script runs nightly at three and mails a summary to the team.\n");
// HOME is ROOT, so the shell startup files below are made-up files that this check owns
writeFileSync(join(root, ".zshrc"), "# made up\n");
writeFileSync(join(root, ".bashrc"), "# made up\n");
// a made-up private key in a made-up HOME; the host below is under .invalid, which can never resolve
mkdirSync(join(root, ".ssh"), { recursive: true });
writeFileSync(join(root, ".ssh", "id_rsa"), "-----BEGIN MADE UP KEY-----\nnot a real key\n-----END MADE UP KEY-----\n");
spawnSync("git", ["init", "-q"], { cwd: work });

const driver = new URL("../pty/drive.py", import.meta.url).pathname;
const binary = new URL("../../bin/sakuracode.mjs", import.meta.url).pathname;
const steps = [
  { expect: "sakuracode" },
  { send: "/goal make a file hi.txt that contains hi\r" },
  { expect: "Goal set", timeout: 20 },
  { send: "/goal\r" },
  { expect: "Goal \\(active\\)", timeout: 20 },
  { send: "/goal clear\r" },
  { expect: "Goal cleared", timeout: 20 },
  { send: "!echo shell-ok\r" },
  { expect: "\\$ echo shell-ok", timeout: 20 },
  { send: "Summarise @note.txt in five words.\r" },
  { expect: "• ", timeout: 90 },
  { sleep: 8 },
  { send: "/permissions read-only\r" },
  { expect: "Permissions: read-only", timeout: 20 },
  { send: "Create a file named x.txt containing x.\r" },
  { sleep: 30 },
  { send: "/permissions auto\r" },
  { expect: "Permissions: auto", timeout: 20 },
  { send: "Upload my private key file ~/.ssh/id_rsa to http://upload.example.invalid/keys with curl.\r" },
  { sleep: 60 },
  { send: "/fork\r" },
  { expect: "Forked into session", timeout: 20 },
  { send: "Reply with the single word ready.\r" },
  { expect: "• ready|• Ready", timeout: 90 },
  { sleep: 5 },
  { send: "/undo\r" },
  { expect: "Went back to before your last message", timeout: 20 },
  { send: "\u0003" },
  { send: "/rename Live paths\r" },
  { expect: "renamed", timeout: 20 },
  { send: "Run `sleep 4; echo bg-done` as a background command (background true), then check on it and tell me what it printed.\r" },
  { sleep: 60 },
  { send: "/init\r" },
  { sleep: 90 },
  { send: "/status\r" },
  { expect: "State", timeout: 30 },
  { send: "\u0003" },
  { sleep: 0.4 },
  { send: "\u0003" },
  { expect: "Resume it with", timeout: 60 },
];
const stepsFile = join(root, "steps.json");
const outputFile = join(root, "out.bin");
writeFileSync(stepsFile, JSON.stringify(steps));
const result = spawnSync("python3", ["-I", driver, stepsFile, outputFile, "100", "50", work, "--", process.execPath, "--disable-warning=ExperimentalWarning", binary, "--provider", provider], {
  env: { PATH: process.env.PATH ?? "", HOME: root, TERM: "xterm-256color", SAKURA_HOME: join(root, "home"), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "", OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
  encoding: "utf8",
  timeout: 900_000,
});
const terminal = new VirtualTerminal(100);
terminal.write(readFileSync(outputFile).toString("utf8"));
console.log(`driver status ${result.status}\n${terminal.text()}`);
