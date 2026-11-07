// Used by exit-cleanup.test.ts: starts a command that would run for a long time, does not wait for it, then does what the first argument says.
import { createLocalEnvironment } from "../../src/index.ts";

const [what, marker] = process.argv.slice(2);
const env = createLocalEnvironment(process.cwd());
env.spawn(`sleep ${marker}`, {});
console.log("started");
if (what === "exit") process.exit(0);
if (what === "throw") throw new Error("script failed");
setInterval(() => undefined, 1000); // "wait": stays alive until a signal arrives
