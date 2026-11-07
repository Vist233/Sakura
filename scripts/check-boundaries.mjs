// Enforces the package dependency rules from the design rules:
// - the kernel imports nothing outside itself,
// - infrastructure packages (llm, env, session, testing) import only the kernel,
// - plugins import only kernel/llm/env/session and never each other,
// - nobody reaches into another package's internals (only the package name).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const SCOPE = "@sakura/";
const BASE_PACKAGES = ["kernel", "llm", "env", "session"];
// The only third-party runtime dependencies, each decided by the user: the JavaScript engine of codemode (design section 7).
const EXTERNAL_ALLOWED = { "plugin-toolset": ["quickjs-emscripten"] };
const ALLOWED = {
  kernel: [],
  llm: ["kernel"],
  env: ["kernel"],
  session: ["kernel"],
  testing: ["kernel"],
};
// Only real statements count: `import ... from "x"`, `export ... from "x"`, `import "x"` at the start of a line,
// and dynamic `import("x")`. Words inside strings and comments ("... from "In Progress" ...") do not.
const IMPORT_PATTERNS = [/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g];

function listSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : listSourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function discoverPackages(root) {
  const packages = [];
  const top = join(root, "packages");
  if (!existsSync(top)) return packages;
  for (const name of readdirSync(top)) {
    const dir = join(top, name);
    if (!statSync(dir).isDirectory()) continue;
    if (name === "plugins") {
      for (const plugin of readdirSync(dir)) {
        const pluginDir = join(dir, plugin);
        if (statSync(pluginDir).isDirectory()) packages.push({ id: `plugin-${plugin}`, kind: "plugin", dir: pluginDir });
      }
    } else {
      packages.push({ id: name, kind: name in ALLOWED ? "base" : "free", dir });
    }
  }
  return packages;
}

function allowedInternalDeps(pkg) {
  if (pkg.kind === "plugin") return BASE_PACKAGES;
  if (pkg.kind === "base") return ALLOWED[pkg.id];
  return null; // "free" packages such as agent may use anything public
}

function checkImport(specifier, pkg, file, isTest, root) {
  const where = relative(root, file);
  if (specifier.startsWith("node:") || builtinModules.includes(specifier)) return null;
  if (specifier.startsWith(".")) {
    const target = join(file, "..", specifier);
    const inside = relative(pkg.dir, target);
    return inside.startsWith("..") ? `${where}: relative import leaves its package (${specifier})` : null;
  }
  if (specifier.startsWith(SCOPE)) {
    const rest = specifier.slice(SCOPE.length);
    if (rest.includes("/")) return `${where}: deep import into another package (${specifier}); import the package name only`;
    if (isTest) return null;
    const allowed = allowedInternalDeps(pkg);
    if (allowed && !allowed.includes(rest)) return `${where}: package '${pkg.id}' may not import '${rest}'`;
    return null;
  }
  if (EXTERNAL_ALLOWED[pkg.id]?.includes(specifier)) return null;
  if (isTest && (specifier === "vitest" || specifier.startsWith("vitest/"))) return null;
  return `${where}: external dependency '${specifier}' is not allowed (the library has no runtime dependencies)`;
}

export function checkBoundaries(root) {
  const violations = [];
  for (const pkg of discoverPackages(root)) {
    for (const folder of ["src", "test"]) {
      const isTest = folder === "test";
      for (const file of listSourceFiles(join(pkg.dir, folder))) {
        const text = readFileSync(file, "utf8");
        for (const pattern of IMPORT_PATTERNS) {
          for (const match of text.matchAll(pattern)) {
            const problem = checkImport(match[1], pkg, file, isTest, root);
            if (problem) violations.push(problem);
          }
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const violations = checkBoundaries(root);
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log(`boundaries ok (${discoverPackages(root).length} packages)`);
}
