import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Environment } from "@sakura/kernel";
import { createRng } from "@sakura/testing";
import { createLocalEnvironment } from "../src/index.ts";

let dir: string;
let env: Environment;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "env-gen-"));
  env = createLocalEnvironment(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const range = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => index + 1 + offset);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("generated: shell arithmetic and text", () => {
  for (const seed of range(60)) {
    it(`computes in the shell (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const a = rng.int(0, 5000);
      const b = rng.int(1, 5000);
      const result = await env.exec(`echo $(( ${a} * ${b} + ${a} % ${b} ))`, {});
      expect(result.output.trim()).toBe(String(a * b + (a % b)));
    });
  }

  for (const seed of range(40, 100)) {
    it(`handles quoting (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const word = Array.from({ length: rng.int(1, 12) }, () => rng.pick(["a", "b", "Z", "9", "_", "-", " ", "é", "好"])).join("");
      const result = await env.exec(`printf '%s' ${JSON.stringify(word)}`, {});
      expect(result.output).toBe(word);
    });
  }
});

describe("generated: file names", () => {
  const names = ["plain.txt", "with space.txt", "ünïcode.txt", "日本語.txt", "dash-name", "dot.dot.dot", ".hidden", "UPPER", "a'b", "tab\there"];
  for (const name of names) {
    for (const variant of range(3)) {
      it(`round trips a file named ${JSON.stringify(name)} (variant ${variant})`, async () => {
        const content = `content ${variant} ${name}`;
        await env.writeFile(`dir${variant}/${name}`, content);
        expect(decode(await env.readFile(`dir${variant}/${name}`))).toBe(content);
        expect(await env.list(`dir${variant}`)).toContain(name);
      });
    }
  }
});

describe("generated: directory listings", () => {
  for (const seed of range(25, 200)) {
    it(`lists every file that was written (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const count = rng.int(0, 30);
      const created = Array.from({ length: count }, (_, index) => `f${String(index).padStart(3, "0")}_${rng.int(0, 99)}`);
      for (const name of created) await env.writeFile(`box/${name}`, name);
      expect(await env.list("box").catch(() => [])).toEqual([...created].sort());
    });
  }
});

describe("generated: paths", () => {
  for (const seed of range(30, 300)) {
    it(`resolve stays inside the directory for relative paths (seed ${seed})`, () => {
      const rng = createRng(seed);
      const parts = Array.from({ length: rng.int(1, 6) }, () => rng.pick(["a", "b", "c", "dd", "e.e"]));
      const resolved = env.resolve(parts.join("/"));
      expect(resolved.startsWith(`${dir}/`)).toBe(true);
      expect(resolved.endsWith(parts.join("/"))).toBe(true);
    });
  }
});

describe("generated: exec in parallel", () => {
  for (const seed of range(15, 400)) {
    it(`several commands at once do not mix their output (seed ${seed})`, async () => {
      const rng = createRng(seed);
      const count = rng.int(2, 6);
      const words = Array.from({ length: count }, (_, index) => `w${index}_${rng.int(0, 99999)}`);
      const results = await Promise.all(words.map((word) => env.exec(`sleep 0.0${rng.int(1, 9)}; echo ${word}`, {})));
      expect(results.map((result) => result.output.trim())).toEqual(words);
    });
  }
});
