import { describe, expect, it } from "vitest";
import { CodexModelClient, auditEvents } from "../src/codex-client.ts";

const item = (i: Record<string, unknown>) => JSON.stringify({ type: "item.completed", item: i });
const NOTICE = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";

describe("codex lane audit", () => {
  it("passes a plain reply with the fail-closed notice", () => {
    const t = auditEvents([item({ type: "error", message: NOTICE }), item({ type: "agent_message", text: "{}" })]);
    expect(t.toolItems).toEqual([]);
    expect(t.text).toBe("{}");
  });
  it("fails on any other error item", () => {
    expect(auditEvents([item({ type: "error", message: "something else" })]).toolItems).toEqual(["error"]);
  });
  it("fails on tool items", () => {
    for (const type of ["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"]) expect(auditEvents([item({ type })]).toolItems).toEqual([type]);
  });
  it("fails on a refused attempt seen only on stderr", () => {
    const t = auditEvents([item({ type: "agent_message", text: "{}" })], "ERROR codex_core::tools::router: error=code-mode host is disabled");
    expect(t.toolItems).toEqual(["refused-tool-attempt"]);
  });
});

describe("codex lane watchdog", () => {
  const profile = { id: "t", label: "t", model: "m", reasoningEffort: null, carryReasoning: false, inputPerMTok: 0, outputPerMTok: 0, maxContextChars: 1000 };
  const req = { profile, instructions: "i", input: [], mode: "tools" as const, maxOutputTokens: 10 };
  const reply = { code: 0, stderr: "", lines: [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ tool: "check_candidate", envelope: { isa: "ANMA-1", hex: "00", annotations: null } }) } })] };
  const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const events = async (client: CodexModelClient) => {
    const out: string[] = [];
    for await (const e of client.turn(req as never, new AbortController().signal)) out.push(e.type === "error" ? e.code : e.type);
    return out;
  };
  it("retries a call that never returns", async () => {
    let n = 0;
    const client = new CodexModelClient({ model: "m", effort: "low", turnTimeoutMs: 20, run: async (_p, _s, _c, _m, _e, signal) => (++n < 3 ? hang(signal) : reply) });
    expect(await events(client)).toContain("completed");
    expect(client.hungCalls).toBe(2);
  });
  it("gives up after its attempts", async () => {
    const client = new CodexModelClient({ model: "m", effort: "low", turnTimeoutMs: 10, run: (_p, _s, _c, _m, _e, signal) => hang(signal) });
    expect(await events(client)).toEqual(["lane_hung"]);
  });
});
