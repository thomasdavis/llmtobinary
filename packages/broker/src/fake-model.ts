// TEST-ONLY scripted model client. It replays a fixed list of turns so every loop outcome can be
// exercised deterministically. The Worker enables it only when ENVIRONMENT === "test" and
// TEST_FAKE_MODEL === "1"; neither is ever set by wrangler.jsonc for a deployed environment.

import type { ModelClient, ModelEvent, ModelTurnRequest } from "./model.ts";

export type ScriptedTurn =
  | { kind: "check" | "submit"; envelope: unknown; usage?: { input: number; output: number } }
  | { kind: "text"; text: string; usage?: { input: number; output: number } }
  | { kind: "refuse"; message?: string }
  | { kind: "incomplete"; reason?: string }
  | { kind: "error"; code: string; retryable: boolean }
  | { kind: "hang" };

export class FakeModelClient implements ModelClient {
  readonly kind = "fake" as const;
  private i = 0;
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly script: ScriptedTurn[]) {}

  async *turn(req: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const t = this.script[this.i++];
    const n = this.i;
    if (!t) {
      yield { type: "error", code: "script_exhausted", message: "the fake model script has no more turns", retryable: false, status: null };
      return;
    }
    const usage = "usage" in t && t.usage ? { inputTokens: t.usage.input, outputTokens: t.usage.output, reasoningTokens: 0 } : { inputTokens: 100, outputTokens: 50, reasoningTokens: 0 };
    switch (t.kind) {
      case "check":
      case "submit": {
        const args = typeof t.envelope === "string" ? t.envelope : JSON.stringify(t.envelope);
        const name = t.kind === "check" ? "check_candidate" : "submit_candidate";
        for (let k = 0; k < args.length; k += 64) yield { type: "tool_args.delta", name, delta: args.slice(k, k + 64) };
        const callId = `call_${n}`;
        yield {
          type: "completed",
          responseId: `resp_${n}`,
          returnedModel: req.profile.model,
          output: [{ type: "function_call", id: `fc_${n}`, call_id: callId, name, arguments: args, status: "completed" }],
          functionCalls: [{ name, callId, arguments: args, itemId: `fc_${n}` }],
          text: "",
          refusal: null,
          usage,
        };
        return;
      }
      case "text":
        yield { type: "text.delta", delta: t.text };
        yield { type: "completed", responseId: `resp_${n}`, returnedModel: req.profile.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: t.text }] }], functionCalls: [], text: t.text, refusal: null, usage };
        return;
      case "refuse":
        yield { type: "completed", responseId: `resp_${n}`, returnedModel: req.profile.model, output: [], functionCalls: [], text: "", refusal: t.message ?? "I can't help with that.", usage };
        return;
      case "incomplete":
        yield { type: "incomplete", responseId: `resp_${n}`, reason: t.reason ?? "max_output_tokens", usage };
        return;
      case "error":
        yield { type: "error", code: t.code, message: `scripted ${t.code}`, retryable: t.retryable, status: null };
        return;
      case "hang":
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "error", code: "aborted", message: "the request was cancelled", retryable: false, status: null };
        return;
    }
  }
}
