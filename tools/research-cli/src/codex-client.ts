// Flat-lane ModelClient: one `codex exec` per turn, stateless, with the execution host disabled.
// The model cannot run anything, so it has no assembler. Every turn's event log is audited, and a
// tool item or refused tool attempt fails the session (docs/os-evidence/gate-a-prereg.md).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateEnvelopeSchema } from "@llmtobinary/broker";
import type { ModelClient, ModelEvent, ModelTurnRequest } from "@llmtobinary/broker";

export const CODEX_LANE = "codex-sol";
export const TOOL_AUDIT_FAILED = "tool_audit_failed";

const DISABLED = ["shell_tool", "unified_exec", "code_mode_host", "code_mode_interrupt", "plugins", "apps", "multi_agent", "view_image", "image_generation", "skill_search", "tool_suggest", "browser_use", "computer_use", "sleep_tool", "incremental_tools"];
const ALLOWED_ITEMS = new Set(["agent_message", "reasoning"]);

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "envelope"],
  properties: { tool: { type: "string", enum: ["check_candidate", "submit_candidate"] }, envelope: candidateEnvelopeSchema },
};

const PROTOCOL = `You have no tools in this environment and must not try to run anything. Work out the bytes yourself.
Reply with one JSON object: "tool" is check_candidate or submit_candidate, and "envelope" is that tool's argument. Everything the instructions say about calling those two tools applies to this reply.`;

/** Renders the loop's self-contained input items as a transcript. */
export function renderTranscript(items: unknown[]): string {
  return items
    .map((raw) => {
      const it = raw as Record<string, unknown>;
      if (it.type === "function_call") return `YOU CALLED ${String(it.name)} WITH:\n${String(it.arguments)}`;
      if (it.type === "function_call_output") return `TOOL RESULT:\n${String(it.output)}`;
      if (typeof it.role === "string") return `${it.role.toUpperCase()}:\n${typeof it.content === "string" ? it.content : JSON.stringify(it.content)}`;
      return JSON.stringify(it);
    })
    .join("\n\n");
}

export interface CodexRunResult {
  code: number | null;
  lines: string[];
  stderr: string;
}

export type CodexRunner = (prompt: string, schemaPath: string, cwd: string, model: string, effort: string, signal: AbortSignal) => Promise<CodexRunResult>;

export const runCodex: CodexRunner = (prompt, schemaPath, cwd, model, effort, signal) =>
  new Promise((resolve, reject) => {
    const args = ["exec", "--ignore-user-config", "--ignore-rules", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-c", 'web_search="disabled"', "--output-schema", schemaPath, ...DISABLED.flatMap((f) => ["--disable", f]), "-"];
    const child = spawn("codex", args, { cwd, signal, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, lines: out.split("\n").filter(Boolean), stderr: err.slice(-2000) }));
    child.stdin.end(prompt);
  });

export interface AuditedTurn {
  text: string;
  toolItems: string[];
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
}

/** Reads a turn's event log. Anything other than plain messages and reasoning is a tool item. */
export function auditEvents(lines: string[]): AuditedTurn {
  let text = "";
  const toolItems: string[] = [];
  let usage: AuditedTurn["usage"] = null;
  for (const line of lines) {
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const item = e.item as Record<string, any> | undefined;
    if (item?.type && !ALLOWED_ITEMS.has(item.type) && !toolItems.includes(item.type)) toolItems.push(item.type);
    if (e.type === "item.completed" && item?.type === "agent_message") text = String(item.text ?? "");
    if (e.usage) usage = { inputTokens: e.usage.input_tokens ?? 0, outputTokens: e.usage.output_tokens ?? 0, reasoningTokens: e.usage.reasoning_output_tokens ?? 0 };
  }
  return { text, toolItems, usage };
}

export class CodexModelClient implements ModelClient {
  readonly kind = "research" as const;
  private n = 0;
  readonly audit: { turn: number; toolItems: string[] }[] = [];

  constructor(private readonly opts: { model: string; effort: string; run?: CodexRunner }) {}

  async *turn(req: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const n = ++this.n;
    const dir = mkdtempSync(join(process.env.CODEX_LANE_TMP ?? tmpdir(), "codex-turn-"));
    try {
      const schemaPath = join(dir, "reply.schema.json");
      writeFileSync(schemaPath, JSON.stringify(REPLY_SCHEMA));
      const prompt = `${req.instructions}\n\n${PROTOCOL}\n\n${renderTranscript(req.input)}`;
      const r = await (this.opts.run ?? runCodex)(prompt, schemaPath, dir, this.opts.model, this.opts.effort, signal);
      const t = auditEvents(r.lines);
      this.audit.push({ turn: n, toolItems: t.toolItems });
      if (t.toolItems.length) {
        yield { type: "error", code: TOOL_AUDIT_FAILED, message: `the lane's event log holds ${t.toolItems.join(", ")}`, retryable: false, status: null };
        return;
      }
      if (r.code !== 0 || !t.text) {
        yield { type: "error", code: "lane_failed", message: `codex exited ${r.code}: ${r.stderr.slice(-300)}`, retryable: false, status: null };
        return;
      }
      let reply: { tool: string; envelope: unknown };
      try {
        reply = JSON.parse(t.text);
      } catch {
        yield { type: "error", code: "lane_bad_reply", message: "the reply was not JSON", retryable: false, status: null };
        return;
      }
      const args = JSON.stringify(reply.envelope);
      const callId = `call_${n}`;
      yield { type: "tool_args.delta", name: reply.tool, delta: args };
      yield {
        type: "completed",
        responseId: `codex_${n}`,
        returnedModel: this.opts.model,
        output: [{ type: "function_call", id: `fc_${n}`, call_id: callId, name: reply.tool, arguments: args, status: "completed" }],
        functionCalls: [{ name: reply.tool, callId, arguments: args, itemId: `fc_${n}` }],
        text: "",
        refusal: null,
        usage: t.usage,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
