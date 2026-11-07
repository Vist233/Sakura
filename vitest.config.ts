import { defineConfig } from "vitest/config";

// The public offline suites check packages and repository rules:
//   unit      one package at a time, in packages/<name>/test
//   contract  one suite run against every implementation of an interface (*.contract.test.ts)
//   tools     dev tooling: repo-wide checks (scripts/test)
const shared = { testTimeout: 20_000 };
export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: "unit", include: ["packages/**/test/**/*.test.ts"], exclude: ["**/*.contract.test.ts", "**/node_modules/**"] } },
      { test: { ...shared, name: "contract", include: ["packages/**/test/**/*.contract.test.ts"] } },
      { test: { ...shared, name: "tools", include: ["scripts/test/**/*.test.ts"] } },
    ],
  },
});
