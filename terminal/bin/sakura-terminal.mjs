#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from "../src/cli.ts";

const code = await main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
// Leave at once: a cancelled request or a paused terminal handle must not keep the process alive after the session has ended.
process.stdout.write("", () => process.exit(code));
