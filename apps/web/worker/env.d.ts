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
  /** Accounts and social data (D1). */
  COMMUNITY_DB?: D1Database;
  /** Content-addressed objects and attestations (R2). */
  REGISTRY?: R2Bucket;
  REGISTRY_LOG?: DurableObjectNamespace<import("./community/log.ts").RegistryLog>;
  /** JSON list of trusted public keys: [{ keyid, publicKeyHex, role }]. */
  TRUSTED_KEYS?: string;
  BROKER_KEY_ID?: string;
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
  /** Production only: page loads on any other host redirect here (e.g. "llmtobinary.com"). */
  CANONICAL_HOST?: string;
  /** "true" requires a GitHub sign-in to generate; ignored until sign-in is configured. */
  GENERATION_REQUIRES_SIGN_IN?: string;
  // secrets (wrangler secret put / .dev.vars) — never in wrangler.jsonc
  OPENAI_API_KEY?: string;
  SESSION_SIGNING_KEY?: string;
  /** Operator key for /api/admin/* (program-list rebuild). */
  GALLERY_ADMIN_KEY?: string;
  /** PKCS8 hex. Signs provenance at generation time. */
  BROKER_SIGNING_KEY?: string;
  VERIFIER_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // test-only (never set for deployed environments)
  TEST_FAKE_MODEL?: string;
  TEST_FAKE_SCRIPT?: string;
  TEST_FAKE_OAUTH?: string;
}

declare const __BUILD_COMMIT__: string;

declare module "*.sql?raw" {
  const text: string;
  export default text;
}
