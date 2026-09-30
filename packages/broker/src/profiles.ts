// Versioned model-profile and price policy (PRD Section 7.1/7.6). Profiles come from deployment
// configuration; there is no automatic "latest" alias and no fallback to another model or provider.

import type { ModelProfile } from "./model.ts";

export const PRICE_POLICY_VERSION = "llmtobinary-prices/1";

export interface ProfileEnv {
  OPENAI_MODEL?: string;
  OPENAI_PROFILE_LABEL?: string;
  OPENAI_REASONING_EFFORT?: string;
  OPENAI_CARRY_REASONING?: string;
  OPENAI_PRICE_INPUT_PER_MTOK?: string;
  OPENAI_PRICE_OUTPUT_PER_MTOK?: string;
  MAX_CONTEXT_CHARS?: string;
}

const EFFORTS = new Set(["minimal", "low", "medium", "high"]);

export type ProfileResult = { ok: true; profile: ModelProfile } | { ok: false; reason: string };

/** Build the single configured profile; any missing or invalid value disables live generation. */
export function profileFromEnv(env: ProfileEnv): ProfileResult {
  const model = (env.OPENAI_MODEL ?? "").trim();
  if (!model) return { ok: false, reason: "OPENAI_MODEL is not configured" };
  const effort = (env.OPENAI_REASONING_EFFORT ?? "").trim();
  if (effort && !EFFORTS.has(effort)) return { ok: false, reason: `OPENAI_REASONING_EFFORT must be one of ${[...EFFORTS].join(", ")}` };
  const inP = Number(env.OPENAI_PRICE_INPUT_PER_MTOK);
  const outP = Number(env.OPENAI_PRICE_OUTPUT_PER_MTOK);
  if (!Number.isFinite(inP) || inP <= 0 || !Number.isFinite(outP) || outP <= 0) {
    return { ok: false, reason: "OPENAI_PRICE_INPUT_PER_MTOK and OPENAI_PRICE_OUTPUT_PER_MTOK must be positive numbers (the budget ledger needs prices)" };
  }
  const maxCtx = Number(env.MAX_CONTEXT_CHARS ?? 600_000);
  return {
    ok: true,
    profile: {
      id: "default",
      label: env.OPENAI_PROFILE_LABEL?.trim() || model,
      model,
      reasoningEffort: (effort || null) as ModelProfile["reasoningEffort"],
      carryReasoning: env.OPENAI_CARRY_REASONING === "true",
      inputPerMTok: inP,
      outputPerMTok: outP,
      maxContextChars: Number.isFinite(maxCtx) && maxCtx > 10_000 ? maxCtx : 600_000,
    },
  };
}
