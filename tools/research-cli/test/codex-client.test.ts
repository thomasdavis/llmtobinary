import { describe, expect, it } from "vitest";
import { auditEvents } from "../src/codex-client.ts";

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
