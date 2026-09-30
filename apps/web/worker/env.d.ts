// Worker environment (hand-maintained; `pnpm --filter @llmtobinary/web types` can regenerate from wrangler.jsonc).

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: Fetcher;
  GENERATION_SESSION: DurableObjectNamespace<import("./session.ts").GenerationSession>;
  BUDGET_LEDGER: DurableObjectNamespace<import("./ledger.ts").BudgetLedger>;
  /** Private debug archive of generation sessions (R2). */
  DEBUG_ARCHIVE?: R2Bucket;
  ADMISSION_LIMITER?: RateLimit;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  // vars
  ENVIRONMENT: string;
  LIVE_GENERATION_ENABLED: string;
  OPENAI_MODEL?: string;
  OPENAI_PROFILE_LABEL?: string;
  OPENAI_REASONING_EFFORT?: string;
  OPENAI_OPEN_TASK_REASONING_EFFORT?: string;
  OPENAI_CARRY_REASONING?: string;
  OPENAI_PRICE_INPUT_PER_MTOK?: string;
  OPENAI_PRICE_OUTPUT_PER_MTOK?: string;
  SESSION_USD_CAP?: string;
  DAILY_USD_CAP?: string;
  RECOVERY_TTL_SECONDS?: string;
  ALLOWED_FEATURES?: string;
  MAX_CONTEXT_CHARS?: string;
  // secrets (wrangler secret put / .dev.vars) — never in wrangler.jsonc
  OPENAI_API_KEY?: string;
  SESSION_SIGNING_KEY?: string;
  // test-only (never set for deployed environments)
  TEST_FAKE_MODEL?: string;
  TEST_FAKE_SCRIPT?: string;
}

declare const __BUILD_COMMIT__: string;
