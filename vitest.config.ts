import { defineConfig } from "vitest/config";

// Unit and conformance tests for every package, tool, and the web app's pure modules.
// The Cloudflare Worker has its own config (apps/web/vitest.worker.config.ts) that runs in workerd.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/*/test/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    pool: "threads",
    maxWorkers: 3,
    testTimeout: 60_000,
  },
});
