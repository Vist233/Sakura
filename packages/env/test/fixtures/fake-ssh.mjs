#!/usr/bin/env node
// A stand-in for the ssh program, for tests. It understands the few forms connectSsh uses and runs the remote command on this machine.
//   FAKE_SSH_LOG         file that gets one JSON line per call: { kind: "master" | "command" | "exit", ... }
//   FAKE_SSH_CONNECT_FAIL  set: opening the connection fails like a refused connection
//   FAKE_SSH_DROP_ON     comma separated numbers: those commands (counting from 1) fail like a dropped connection (exit 255)
//   FAKE_SSH_CUT_AFTER_MS  with FAKE_SSH_DROP_ON: the command is run, and the connection drops that many milliseconds later (the command's shell is killed, exit 255)
//   FAKE_SSH_PATH_PREFIX added in front of PATH for the command (macOS has no setsid; tests put a stand-in in this folder)
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const options = {};
const flags = new Set();
const rest = [];
for (let index = 0; index < argv.length; index++) {
  const word = argv[index];
  if (rest.length > 0 || !word.startsWith("-")) {
    rest.push(word);
  } else if (["-o", "-p", "-i", "-O", "-J", "-l"].includes(word)) {
    const value = argv[++index];
    if (word === "-o") {
      const [name, ...more] = value.split("=");
      options[name] = more.join("=");
    } else options[word] = value;
  } else flags.add(word);
}
const host = rest[0];
const command = rest.slice(1).join(" ");
const log = (entry) => process.env.FAKE_SSH_LOG && appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ ...entry, host, argv })}\n`);
const marker = (options.ControlPath ?? "").replace("%C", "master");

if (options["-O"] === "exit") {
  log({ kind: "exit" });
  rmSync(marker, { force: true });
  process.exit(0);
}

if (command === "") {
  if (process.env.FAKE_SSH_CONNECT_FAIL) {
    process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\n`);
    process.exit(255);
  }
  writeFileSync(marker, "up");
  log({ kind: "master", control: options.ControlPath });
  process.exit(0);
}

// commands arrive at the same time, so they are numbered under a lock
function nextNumber() {
  const counter = `${process.env.FAKE_SSH_LOG}.count`;
  const lock = `${counter}.lock`;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  const number = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  writeFileSync(counter, String(number));
  rmSync(lock, { recursive: true });
  return number;
}
const number = process.env.FAKE_SSH_LOG ? nextNumber() : 1;
log({ kind: "command", number, control: options.ControlPath, command });
const dropped = (process.env.FAKE_SSH_DROP_ON ?? "").split(",").includes(String(number));
if (dropped && !process.env.FAKE_SSH_CUT_AFTER_MS) {
  process.stderr.write("client_loop: send disconnect: Broken pipe\n");
  process.exit(255);
}
if (!existsSync(marker)) writeFileSync(marker, "up"); // ControlMaster=auto makes a new connection when there is none

const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PATH: `${process.env.FAKE_SSH_PATH_PREFIX ?? ""}:${process.env.PATH}` } });
if (dropped) {
  setTimeout(() => {
    child.kill("SIGKILL");
    process.stderr.write("client_loop: send disconnect: Broken pipe\n");
    process.exit(255);
  }, Number(process.env.FAKE_SSH_CUT_AFTER_MS)).unref();
}
process.on("SIGTERM", () => {
  child.kill("SIGKILL");
  process.exit(143);
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
