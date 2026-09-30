// Provider-neutral model-turn interface used by the loop controller, plus the normalized events
// a turn yields. The OpenAI adapter and the test-only scripted fake implement it.

export interface ModelProfile {
  id: string;
  label: string;
  /** Requested model ID (an explicit snapshot when available). */
  model: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | null;
  carryReasoning: boolean;
  /** USD per million tokens, from the versioned price policy. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Approximate context budget for loop input, in characters (deterministic elision beyond it). */
  maxContextChars: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface FunctionCall {
  name: string;
  callId: string;
  arguments: string;
  itemId: string | null;
}

export interface ModelTurnRequest {
  profile: ModelProfile;
  instructions: string;
  /** Self-contained input items (user messages, prior output items, function_call_output items). */
  input: unknown[];
  mode: "tools" | "raw-hex";
  maxOutputTokens: number;
}

export type ModelEvent =
  | { type: "text.delta"; delta: string }
  | { type: "tool_args.delta"; name: string | null; delta: string }
  | {
      type: "completed";
      responseId: string | null;
      returnedModel: string | null;
      /** Output items to carry forward into the next turn's input (reasoning items only when carried). */
      output: unknown[];
      functionCalls: FunctionCall[];
      text: string;
      refusal: string | null;
      usage: ModelUsage | null;
    }
  | { type: "incomplete"; responseId: string | null; reason: string; usage: ModelUsage | null }
  | { type: "error"; code: string; message: string; retryable: boolean; status: number | null };

export interface ModelClient {
  readonly kind: "openai" | "fake";
  turn(req: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
