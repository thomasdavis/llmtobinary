// OpenAI Responses adapter (PRD Section 7.3/7.4): official SDK, foreground streaming, store:false,
// strict function tools, tool_choice required, no parallel tool calls, no opaque SDK retries.
// Output item identities are preserved; unrelated items are never concatenated. Encrypted
// reasoning items are round-tripped only when the profile carries reasoning, and never logged.

import OpenAI from "openai";
import type { FunctionCall, ModelClient, ModelEvent, ModelTurnRequest, ModelUsage, ReviewRequest, ReviewResult } from "./model.ts";
import { ANMR_TOOLS, REVIEW_TOOL, REVIEW_TOOL_NAME, TOOLS } from "./schema.ts";
import { RAW_HEX_ADDENDUM } from "./prompts.ts";

export interface OpenAIClientOptions {
  apiKey: string;
  baseURL?: string;
  /** Injected fetch (tests); defaults to the platform fetch. */
  fetch?: typeof fetch;
}

function usageOf(u: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } } | null | undefined): ModelUsage | null {
  if (!u) return null;
  return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0 };
}

export class OpenAIModelClient implements ModelClient {
  readonly kind = "openai" as const;
  private readonly client: OpenAI;

  constructor(opts: OpenAIClientOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: 0, // Retries are accounted for by the loop controller.
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async *turn(req: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const tools = req.mode === "tools";
    const params = {
      model: req.profile.model,
      instructions: tools ? req.instructions : `${req.instructions}\n\n${RAW_HEX_ADDENDUM}`,
      input: req.input,
      store: false,
      stream: true as const,
      max_output_tokens: req.maxOutputTokens,
      ...(req.profile.reasoningEffort ? { reasoning: { effort: req.profile.reasoningEffort } } : {}),
      ...(tools && req.profile.carryReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
      ...(tools ? { tools: req.isa === "ANMR-1" ? ANMR_TOOLS : TOOLS, tool_choice: "required" as const, parallel_tool_calls: false } : { tools: [] }),
    };
    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      stream = (await this.client.responses.create(params as never, { signal })) as unknown as AsyncIterable<Record<string, unknown>>;
    } catch (e) {
      yield this.errorEvent(e);
      return;
    }
    const names = new Map<string, string>();
    let refusal = "";
    try {
      for await (const ev of stream) {
        const type = ev.type as string;
        if (type === "response.output_item.added") {
          const item = ev.item as { type?: string; id?: string; name?: string };
          if (item?.type === "function_call" && item.id) names.set(item.id, item.name ?? "");
        } else if (type === "response.output_text.delta") {
          yield { type: "text.delta", delta: String(ev.delta ?? "") };
        } else if (type === "response.function_call_arguments.delta") {
          yield { type: "tool_args.delta", name: names.get(String(ev.item_id)) ?? null, delta: String(ev.delta ?? "") };
        } else if (type === "response.refusal.delta") {
          refusal += String(ev.delta ?? "");
        } else if (type === "response.completed") {
          const r = ev.response as { id?: string; model?: string; output?: Record<string, unknown>[]; usage?: never };
          const output = (r.output ?? []).filter((it) => it.type !== "reasoning" || (req.profile.carryReasoning && tools));
          const functionCalls: FunctionCall[] = (r.output ?? [])
            .filter((it) => it.type === "function_call")
            .map((it) => ({ name: String(it.name), callId: String(it.call_id), arguments: String(it.arguments ?? ""), itemId: (it.id as string | undefined) ?? null }));
          let text = "";
          for (const it of r.output ?? []) {
            if (it.type !== "message") continue;
            for (const c of (it.content as { type: string; text?: string; refusal?: string }[]) ?? []) {
              if (c.type === "output_text") text += c.text ?? "";
              if (c.type === "refusal") refusal += c.refusal ?? "";
            }
          }
          yield { type: "completed", responseId: r.id ?? null, returnedModel: r.model ?? null, output, functionCalls, text, refusal: refusal || null, usage: usageOf(r.usage) };
          return;
        } else if (type === "response.incomplete") {
          const r = ev.response as { id?: string; incomplete_details?: { reason?: string }; usage?: never };
          yield { type: "incomplete", responseId: r.id ?? null, reason: r.incomplete_details?.reason ?? "unknown", usage: usageOf(r.usage) };
          return;
        } else if (type === "response.failed") {
          const r = ev.response as { error?: { code?: string; message?: string } };
          yield { type: "error", code: r.error?.code ?? "response_failed", message: r.error?.message ?? "the provider reported a failed response", retryable: false, status: null };
          return;
        } else if (type === "error") {
          yield { type: "error", code: String(ev.code ?? "stream_error"), message: String(ev.message ?? "stream error"), retryable: false, status: null };
          return;
        }
      }
      yield { type: "error", code: "stream_ended", message: "the stream ended without a completed response", retryable: true, status: null };
    } catch (e) {
      yield this.errorEvent(e);
    }
  }

  /** A non-streamed review call; the verdict comes back through the forced, strict review tool. */
  async review(req: ReviewRequest, signal: AbortSignal): Promise<ReviewResult> {
    try {
      const r = (await this.client.responses.create(
        {
          model: req.profile.model,
          instructions: req.instructions,
          input: [{ role: "user", content: [{ type: "input_text", text: req.text }, ...req.images.map((url) => ({ type: "input_image", image_url: url, detail: "auto" }))] }],
          store: false,
          max_output_tokens: req.maxOutputTokens,
          ...(req.profile.reasoningEffort ? { reasoning: { effort: req.profile.reasoningEffort } } : {}),
          tools: [REVIEW_TOOL],
          tool_choice: { type: "function", name: REVIEW_TOOL_NAME },
          parallel_tool_calls: false,
        } as never,
        { signal },
      )) as unknown as { output?: Record<string, unknown>[]; usage?: never };
      const usage = usageOf(r.usage);
      const call = (r.output ?? []).find((it) => it.type === "function_call" && it.name === REVIEW_TOOL_NAME);
      if (!call) return { ok: false, message: "the reviewer returned no verdict", usage };
      // Arguments of a strict function tool, already validated against REVIEW_TOOL by the API.
      const v = JSON.parse(String(call.arguments ?? "{}")) as { complete?: unknown; delivered?: unknown; missing?: unknown };
      if (typeof v.complete !== "boolean" || typeof v.delivered !== "string" || !Array.isArray(v.missing)) return { ok: false, message: "the reviewer's verdict did not match its schema", usage };
      return { ok: true, verdict: { complete: v.complete, delivered: v.delivered.slice(0, 600), missing: v.missing.filter((m): m is string => typeof m === "string").slice(0, 8).map((m) => m.slice(0, 300)) }, usage };
    } catch (e) {
      return { ok: false, message: String((e as Error)?.message ?? e).slice(0, 300), usage: null };
    }
  }

  private errorEvent(e: unknown): ModelEvent {
    if (e instanceof OpenAI.APIUserAbortError || (e as { name?: string })?.name === "AbortError") {
      return { type: "error", code: "aborted", message: "the request was cancelled", retryable: false, status: null };
    }
    const status = (e as { status?: number })?.status ?? null;
    const code = (e as { code?: string })?.code ?? (status ? `http_${status}` : "network_error");
    const retryable = status === null || status === 429 || status >= 500;
    return { type: "error", code, message: String((e as Error)?.message ?? e).slice(0, 300), retryable, status };
  }
}
