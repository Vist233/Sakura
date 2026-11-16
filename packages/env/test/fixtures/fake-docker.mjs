#!/usr/bin/env node
// A stand-in for the docker program, for tests: `docker exec [-i] [-w DIR] CONTAINER COMMAND...` runs COMMAND on this machine.
//   FAKE_DOCKER_DOWN  set: every call fails like docker does when the container is not running (exit 125)
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
if (argv[0] !== "exec") process.exit(2);
let index = 1;
let cwd;
while (argv[index]?.startsWith("-")) {
  if (argv[index] === "-w") cwd = argv[(index += 2) - 1];
  else index++;
}
const [container, ...command] = argv.slice(index);
if (process.env.FAKE_DOCKER_DOWN) {
  process.stderr.write(`Error response from daemon: container ${container} is not running\n`);
  process.exit(125);
}
const child = spawn(command[0], command.slice(1), { cwd, stdio: ["inherit", "inherit", "inherit"] });
process.on("SIGTERM", () => {
  child.kill("SIGKILL");
  process.exit(143);
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
