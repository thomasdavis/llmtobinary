import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import type { ScriptedTurn } from "@llmtobinary/broker";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
mkdirSync(here("./dist/client"), { recursive: true }); // wrangler.jsonc's assets directory must exist

const sq =
  "414e4d4101000000020000000a0000000000000000000000000000000000000001000000000000000100000001000000020000000000000001000000040000000300000000000000010000000000000022000000010000000000000000000000100000000200000002000000000000002000000003000000010000000200000060000000ffffffff0000000001000000440000000300000000000000000000004300000003000000000000000000000004000000000000000000000000000000";
const bad = sq.slice(0, 288) + sq.slice(320);
const script: ScriptedTurn[] = [
  { kind: "check", envelope: { isa: "ANMA-1", hex: bad, annotations: null } },
  { kind: "check", envelope: { isa: "ANMA-1", hex: sq, annotations: null } },
  { kind: "submit", envelope: { isa: "ANMA-1", hex: sq, annotations: null } },
];
const scripts: Record<string, ScriptedTurn[]> = { default: script, hang: [{ kind: "hang" }] };

// Runs the Worker and its Durable Objects inside workerd. The scripted fake model is enabled ONLY
// by these test bindings (ENVIRONMENT=test + TEST_FAKE_MODEL=1), never by wrangler.jsonc.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@llmtobinary/tasks/registry", replacement: here("../../packages/tasks/src/registry.ts") },
      { find: /^@llmtobinary\/([a-z-]+)$/, replacement: here("../../packages/$1/src/index.ts") },
    ],
  },
  define: { __BUILD_COMMIT__: JSON.stringify("test") },
  plugins: [
    cloudflareTest({
      verbose: !!process.env.POOL_VERBOSE,
      main: "./worker/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "test",
          TEST_FAKE_MODEL: "1",
          TEST_FAKE_SCRIPT: JSON.stringify(scripts),
          SESSION_SIGNING_KEY: "test-signing-key-not-a-secret",
          SESSION_USD_CAP: "1.00",
          DAILY_USD_CAP: "5.00",
        },
      },
    }),
  ],
  test: { include: ["worker/**/*.test.ts"], testTimeout: 60_000 },
});
