import { describe, expect, it } from "vitest";
import { Op } from "@llmtobinary/spec";
import { parseHex, toHex } from "@llmtobinary/decode";
import { validateBytes } from "@llmtobinary/validate";
import { catalogAccess, type LibraryEntry } from "@llmtobinary/link/library";
import type { LoopEvent } from "@llmtobinary/protocol";
import { FakeModelClient, LIBRARY_TOOLS, LIBRARY_GUIDE_VERSION, PROMPT_VERSION, createSession, runAttempt, type ModelProfile, type ScriptedTurn } from "../src/index.ts";

const IMPORT = 0x70;
type Rec = [number, number, number, number];
function file(version: number, records: Rec[]): string {
  const out = new Uint8Array(32 + records.length * 16);
  const v = new DataView(out.buffer);
  [0x414d4e41, version, 1, records.length, 0, 0, 0, 0].forEach((w, i) => v.setUint32(i * 4, w, true));
  records.forEach((r, i) => r.forEach((w, k) => v.setUint32(32 + i * 16 + k * 4, w, true)));
  return toHex(out);
}
const lib = file(2, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CONST_U64, 0, 0, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0], [Op.FUNC, 1, 1, 1], [Op.BLOCK, 0, 1, 1], [Op.PARAM, 0, 1, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0]]);
const moduleHex = file(2, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 2], [Op.CONST_U64, 0, 41, 0], [Op.CALL, 1, 1, 1], [Op.ARG, 0, 0, 0], [Op.RETURN, 1, 0, 0], [Op.END_FUNC, 0, 0, 0], [IMPORT, 1, 1, 1], [Op.PARAM, 0, 1, 0]]);
const plainHex = file(1, [[Op.FUNC, 0, 0, 1], [Op.BLOCK, 0, 0, 1], [Op.CONST_U64, 0, 41, 0], [Op.RETURN, 0, 0, 0], [Op.END_FUNC, 0, 0, 0]]);

const entry: LibraryEntry = { slot: "same", title: "Identity", objectId: "sha256:same", evidence: "E4", features: 1, depends: [], functions: [{ symbol: "id.same", signature: "(a: u64) -> u64", behaviour: "Returns a.", id: 1, params: [1], ret: 1 }] };
const access = catalogAccess([entry], async () => (parseHex(lib) as { ok: true; bytes: Uint8Array }).bytes, 15);

const profile: ModelProfile = { id: "default", label: "test", model: "test-model", reasoningEffort: null, carryReasoning: false, inputPerMTok: 1, outputPerMTok: 4, maxContextChars: 600_000 };
const env = (hex: string, annotations: unknown = null) => ({ isa: "ANMA-1", hex, annotations });

function start(script: ScriptedTurn[], o: { library?: boolean } = {}) {
  const on = o.library ?? true;
  const model = new FakeModelClient(script);
  const events: LoopEvent[] = [];
  const state = createSession({ sessionId: "s", task: { taskId: null, description: "return 41", params: [], returns: "u64", allowedFeatures: 15, requireClaims: false, ...(on ? { library: true, module: true } : {}) }, mode: "tools", profile, now: 0, ttlMs: 1000, ...(on ? { libraryIndex: "- id.same(a: u64) -> u64: Returns a." } : {}) });
  const run = () => runAttempt(state, { idempotencyKey: "a", feedback: null }, { model, ledger: { reserve: async () => ({ ok: true }), reconcile: async () => {} }, emit: async (e) => void events.push(e), now: () => 0, signal: new AbortController().signal, newId: () => crypto.randomUUID(), allowedFeatures: 15, ...(on ? { library: access } : {}) });
  return { model, events, state, run };
}
const outputs = (state: { items: unknown[] }) => (state.items as { type?: string; output?: string }[]).filter((i) => i.type === "function_call_output").map((i) => i.output!);

describe("library sessions", () => {
  it("tells the model about the library and offers the tools", async () => {
    const h = start([{ kind: "submit", envelope: env(plainHex) }]);
    await h.run();
    expect((h.state.items[0] as { content: string }).content).toContain("id.same");
    expect(h.state.promptVersion).toBe(`${PROMPT_VERSION}+${LIBRARY_GUIDE_VERSION}`);
    expect(h.model.requests[0]!.library).toBe(true);
    expect(LIBRARY_TOOLS.map((t) => t.name)).toEqual(["search_library", "use_library"]);
  });
  it("searches, selects, links and hands the browser one plain file", async () => {
    const h = start([{ kind: "search", query: "identity" }, { kind: "use", symbols: ["id.same"] }, { kind: "check", envelope: env(moduleHex) }, { kind: "submit", envelope: env(moduleHex) }]);
    await h.run();
    const sub = h.events.find((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted")!;
    const bytes = (parseHex((JSON.parse(sub.envelopeText) as { hex: string }).hex) as { ok: true; bytes: Uint8Array }).bytes;
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)).toBe(1);
    expect(validateBytes(bytes).ok).toBe(true);
    expect(sub.candidate.sha256).not.toBeNull();
    expect(sub.candidate.link!.uses).toEqual(["id.same"]);
    expect(JSON.parse(sub.candidate.link!.moduleText).hex).toBe(moduleHex);
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(["library.searched", "library.selected", "library.linked"]));
    expect(outputs(h.state)[2]).toContain('"link":{"ok":true');
  });
  it("leaves a plain program byte for byte as the model wrote it", async () => {
    const h = start([{ kind: "submit", envelope: env(plainHex) }]);
    await h.run();
    const sub = h.events.find((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted")!;
    expect((JSON.parse(sub.envelopeText) as { hex: string }).hex).toBe(plainHex);
    expect(sub.candidate.link).toBeUndefined();
  });
  it("sends a link failure back to the model instead of submitting", async () => {
    const h = start([{ kind: "submit", envelope: env(moduleHex) }, { kind: "use", symbols: ["id.same"] }, { kind: "submit", envelope: env(moduleHex) }]);
    await h.run();
    expect(outputs(h.state)[0]).toContain("LINK-MAP");
    expect(h.events.filter((e) => e.type === "candidate.submitted")).toHaveLength(1);
    expect(h.state.counters.submissions).toBe(1);
  });
  it("refuses an unknown symbol and keeps the earlier choice", async () => {
    const h = start([{ kind: "use", symbols: ["id.same"] }, { kind: "use", symbols: ["evil.bytes"] }, { kind: "submit", envelope: env(moduleHex) }]);
    await h.run();
    expect(outputs(h.state)[1]).toContain("not in the library");
    expect(h.state.imports).toEqual(["id.same"]);
  });
  it("drops annotations the link made untrue", async () => {
    const annotations = { summary: "s", params: [], records: [{ index: 3, claim: "(CALL v1 fn1 1)", note: "keep me" }, { index: 2, claim: "(CONST_U64 v0 41)", note: null }, { index: 7, claim: null, note: "an import" }], contracts: [], invariants: [], examples: [] };
    const h = start([{ kind: "use", symbols: ["id.same"] }, { kind: "submit", envelope: env(moduleHex, annotations) }]);
    await h.run();
    const sub = h.events.find((e): e is Extract<LoopEvent, { type: "candidate.submitted" }> => e.type === "candidate.submitted")!;
    expect((JSON.parse(sub.envelopeText) as { annotations: typeof annotations }).annotations.records).toEqual([{ index: 3, claim: null, note: "keep me" }, { index: 2, claim: "(CONST_U64 v0 41)", note: null }]);
  });
  it("limits library calls, then tells the model to get on with it", async () => {
    const h = start([...Array.from({ length: 17 }, (): ScriptedTurn => ({ kind: "search", query: "x" })), { kind: "submit", envelope: env(plainHex) }]);
    await h.run();
    expect(outputs(h.state).at(-1)).toContain("limit");
  });
});

describe("sessions without a library", () => {
  it("are unchanged: no tools, no guide, and a call is refused", async () => {
    const h = start([{ kind: "search", query: "x" }, { kind: "submit", envelope: env(plainHex) }], { library: false });
    await h.run();
    expect(h.model.requests[0]!.library).toBe(false);
    expect((h.state.items[0] as { content: string }).content).not.toContain("library");
    expect(h.state.promptVersion).toBe(PROMPT_VERSION);
    expect(outputs(h.state)[0]).toContain("no library");
  });
  it("do not link a module", async () => {
    const h = start([{ kind: "submit", envelope: env(moduleHex) }], { library: false });
    await h.run();
    expect(h.events.some((e) => e.type === "library.linked")).toBe(false);
  });
});
