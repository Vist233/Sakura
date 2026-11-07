// Design rules that are checked by tests (the ideas come from "A Philosophy of Software Design"):
//   - deep modules: a package offers a small interface and hides the rest, so its exported names have a ceiling;
//   - no cycles: neither between packages nor between the files of one package.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => (name === "node_modules" ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));
const packageDirs = readdirSync(join(root, "packages"))
  .flatMap((name) => (name === "plugins" ? readdirSync(join(root, "packages/plugins")).map((plugin) => join(root, "packages/plugins", plugin)) : [join(root, "packages", name)]))
  .filter((dir) => existsSync(join(dir, "src/index.ts")));
const idOf = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name.replace("@sakura/", "") as string;

/** Names a package exports: values (checked at run time) and types (read from the `export type { ... }` lines). */
async function exportedNames(dir: string) {
  const values = Object.keys(await import(join(dir, "src/index.ts")));
  const source = readFileSync(join(dir, "src/index.ts"), "utf8");
  const types = [...source.matchAll(/export type \{([^}]*)\}/g)].flatMap((match) =>
    match[1]!
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const wildcard = /export type \*/.test(source);
  return { values, types, wildcard };
}

const MAX_VALUES = 12; // functions and constants a package offers
const MAX_TYPES = 20; // types it offers (the kernel is the shared vocabulary and may export all of its types with `export type *`)

describe("deep modules: small interfaces", () => {
  for (const dir of packageDirs) {
    const id = idOf(dir);
    it(`${id} exports at most ${MAX_VALUES} values and ${MAX_TYPES} named types`, async () => {
      const { values, types, wildcard } = await exportedNames(dir);
      expect(values.length, `values of ${id}: ${values.join(", ")}`).toBeLessThanOrEqual(MAX_VALUES);
      if (!wildcard) expect(types.length, `types of ${id}: ${types.join(", ")}`).toBeLessThanOrEqual(MAX_TYPES);
      else expect(id).toBe("kernel");
    });
  }

  it("only the kernel may use `export type *`", async () => {
    for (const dir of packageDirs) if (idOf(dir) !== "kernel") expect(readFileSync(join(dir, "src/index.ts"), "utf8")).not.toMatch(/export type \*|export \* from/);
  });
});

/** Finds one cycle in a graph given as node -> neighbours, or undefined. */
function findCycle(graph: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, 1);
    path.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) return [...path.slice(path.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    state.set(node, 2);
    return undefined;
  };
  for (const node of graph.keys())
    if (!state.has(node)) {
      const found = visit(node);
      if (found) return found;
    }
  return undefined;
}

describe("no cycles", () => {
  it("packages do not depend on each other in a circle", () => {
    const graph = new Map<string, string[]>();
    for (const dir of packageDirs) {
      const deps = new Set<string>();
      for (const file of walk(join(dir, "src"))) for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']@sakura\/([a-z-]+)["']/gm)) deps.add(match[1]!);
      graph.set(idOf(dir), [...deps]);
    }
    expect(findCycle(graph), "package cycle").toBeUndefined();
  });

  for (const dir of packageDirs) {
    it(`the files of ${idOf(dir)} do not import each other in a circle`, () => {
      const graph = new Map<string, string[]>();
      for (const file of walk(join(dir, "src"))) {
        const targets: string[] = [];
        for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["'](\.[^"']+)["']/gm)) targets.push(resolve(dirname(file), match[1]!));
        graph.set(file, targets);
      }
      const cycle = findCycle(graph);
      expect(
        cycle?.map((file) => file.replace(`${dir}/`, "")),
        "file cycle",
      ).toBeUndefined();
    });
  }

  it("the cycle finder itself finds a cycle and accepts a tree", () => {
    expect(
      findCycle(
        new Map([
          ["a", ["b"]],
          ["b", ["c"]],
          ["c", ["a"]],
        ]),
      ),
    ).toEqual(["a", "b", "c", "a"]);
    expect(
      findCycle(
        new Map([
          ["a", ["b", "c"]],
          ["b", ["c"]],
          ["c", []],
        ]),
      ),
    ).toBeUndefined();
    expect(findCycle(new Map([["a", ["a"]]]))).toEqual(["a", "a"]);
  });
});
