import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildCode = process.argv[2] === "--code";
const config = buildCode ? "code/tsconfig.build.json" : "tsconfig.sdk.json";
const output = join(root, buildCode ? "code/dist" : "dist");

function workspaceEntry(name) {
  const folder = name.startsWith("plugin-") ? join("plugins", name.slice("plugin-".length)) : name;
  return join(output, "packages", folder, "src", "index.js");
}

function rewriteImports(file, source) {
  // A published tarball has no npm workspace links. Resolve those imports inside it.
  return source.replace(/(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(@sakura\/[\w-]+|\.{1,2}\/[^"']+\.ts)\2/g, (_match, prefix, quote, specifier) => {
    if (!specifier.startsWith("@sakura/")) return `${prefix}${quote}${specifier.slice(0, -3)}.js${quote}`;
    const target = workspaceEntry(specifier.slice("@sakura/".length));
    if (!existsSync(target)) throw new Error(`Missing SDK module: ${specifier}`);
    const path = relative(dirname(file), target).split(sep).join("/");
    return `${prefix}${quote}${path.startsWith(".") ? path : `./${path}`}${quote}`;
  });
}

rmSync(output, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", config], { cwd: root, stdio: "inherit" });
for (const entry of readdirSync(output, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:js|d\.ts)$/.test(entry.name)) continue;
  const file = join(entry.parentPath, entry.name);
  const source = readFileSync(file, "utf8");
  const rewritten = rewriteImports(file, source);
  if (rewritten !== source) writeFileSync(file, rewritten);
}

if (buildCode) {
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"]) {
    cpSync(join(root, file), join(output, file), { recursive: true });
  }
}
