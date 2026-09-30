import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit and conformance tests for every package, tool, and the web app's pure modules.
// Workspace packages resolve to their sources so tests may use test-only cross-package imports;
// scripts/check-deps.mjs enforces that package *sources* import only declared dependencies.
// The Cloudflare Worker has its own config (apps/web/vitest.worker.config.ts) that runs in workerd.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@llmtobinary/fixture-builder", replacement: here("./tools/fixture-builder/src/index.ts") },
      { find: "@llmtobinary/tasks/registry", replacement: here("./packages/tasks/src/registry.ts") },
      { find: "@llmtobinary/verify/node", replacement: here("./packages/verify/src/node-backend.ts") },
      { find: "@llmtobinary/verify/browser", replacement: here("./packages/verify/src/browser-backend.ts") },
      { find: /^@llmtobinary\/([a-z-]+)$/, replacement: here("./packages/$1/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts", "apps/web/src/**/*.test.ts", "tests/**/*.test.ts"],
    pool: "threads",
    maxWorkers: 3,
    testTimeout: 120_000,
  },
});
