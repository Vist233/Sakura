#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from "../src/cli.ts";

process.exitCode = await main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });
