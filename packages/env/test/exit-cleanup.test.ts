// A command started by the local environment must not outlive the process that started it, however that process ends.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./fixtures/background.mts", import.meta.url));
const alive = (marker: string) =>
  spawnSync("pgrep", ["-f", `sleep ${marker}`])
    .stdout.toString()
    .trim() !== "";
const markers: string[] = [];
const unique = () => {
  const marker = String(40000 + Math.floor(Math.random() * 20000));
  markers.push(marker);
  return marker;
};
afterEach(() => {
  for (const marker of markers.splice(0)) spawnSync("pkill", ["-f", `sleep ${marker}`]); // only if a test failed and left one behind
});

/** Runs the fixture, waits until it says it started; `result` settles when the process has ended (it may end at once). */
async function start(what: string, marker: string) {
  const child = spawn(process.execPath, [script, what, marker], { stdio: ["ignore", "pipe", "ignore"] });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await new Promise<void>((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("started") && resolve()));
  await new Promise((done) => setTimeout(done, 200)); // the shell has started the sleep
  return { child, result };
}

describe("commands of the local environment when the host process ends", () => {
  it("process.exit stops a command that is still running", async () => {
    const marker = unique();
    const { result } = await start("exit", marker);
    expect((await result).code).toBe(0);
    expect(alive(marker)).toBe(false);
  });

  it("an uncaught error stops it too", async () => {
    const marker = unique();
    const { result } = await start("throw", marker);
    expect((await result).code).not.toBe(0);
    expect(alive(marker)).toBe(false);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`${signal} stops the command and still ends the host process by that signal`, async () => {
      const marker = unique();
      const { child, result } = await start("wait", marker);
      expect(alive(marker)).toBe(true);
      child.kill(signal);
      expect((await result).signal).toBe(signal);
      expect(alive(marker)).toBe(false);
    });
  }
});
