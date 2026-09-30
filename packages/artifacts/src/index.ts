// Local artifacts, history, manifests, and portable export/import (PRD Section 19).
// IndexedDB is a per-viewer convenience: every access is wrapped, and an in-memory store is used
// when IndexedDB is unavailable (private windows, blocked storage, quota errors).

import { SPEC_ID } from "@llmtobinary/spec";
import { CATALOG_VERSION } from "@llmtobinary/diagnostics";
import type { EntryInput, MachineConfig, RunResult, TestReport, TickEvent } from "@llmtobinary/protocol";

export const MANIFEST_VERSION = "llmtobinary-manifest/1";
export const BUNDLE_VERSION = "llmtobinary-bundle/1";
export const MAX_IMPORT_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_EXECUTABLE_BYTES = 1024 * 1024;

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const src = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(src.byteLength);
  copy.set(src);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

export type Provenance =
  | { kind: "bundled-fixture"; file: string; origin: string; modelOutput: false }
  | { kind: "model-generated"; sessionId: string; attemptId: string; candidateSeq: number; requestedModel: string | null; returnedModels: string[]; mode: "tools" | "raw-hex"; promptVersion: string | null; modelOutput: true }
  | { kind: "imported"; fileName: string; clientClaimsUnverified: true; modelOutput: boolean };

export interface ArtifactRecord {
  sha256: string;
  byteLength: number;
  bytes: Uint8Array;
  name: string;
  taskId: string | null;
  provenance: Provenance;
  /** Raw annotation sidecar (bound by its own hash). */
  annotations: unknown;
  annotationsSha256: string | null;
  /** Exact model response text, stored separately from the decoded bytes. */
  responseText: string | null;
  status: "valid" | "invalid" | "task-passed" | "task-failed" | "resource-limited" | "executed-unverified";
  createdAt: number;
}

export interface RunRecord {
  runId: string;
  sha256: string;
  at: number;
  config: MachineConfig;
  inputs: EntryInput[];
  ticks: TickEvent[];
  result: {
    status: RunResult["status"];
    returnValue: RunResult["returnValue"];
    terminalBase64: string;
    effectsHash: string;
    effectCount: number;
    framebufferHash: string | null;
    trap: RunResult["trap"];
    counters: RunResult["counters"];
    traceTruncated: boolean;
  };
}

export interface SessionRecord {
  sessionId: string;
  at: number;
  taskId: string | null;
  mode: "tools" | "raw-hex";
  outcome: string | null;
  /** Visible loop transcript (events), stored locally; exported only on explicit opt-in. */
  events: unknown[];
  requestedModel: string | null;
  returnedModels: string[];
}

export interface ArtifactStore {
  readonly persistent: boolean;
  putArtifact(a: ArtifactRecord): Promise<void>;
  getArtifact(sha256: string): Promise<ArtifactRecord | null>;
  listArtifacts(): Promise<ArtifactRecord[]>;
  putRun(r: RunRecord): Promise<void>;
  listRuns(sha256: string): Promise<RunRecord[]>;
  putSession(s: SessionRecord): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  clear(): Promise<void>;
}

export function memoryStore(): ArtifactStore {
  const artifacts = new Map<string, ArtifactRecord>();
  const runs: RunRecord[] = [];
  const sessions = new Map<string, SessionRecord>();
  return {
    persistent: false,
    async putArtifact(a) {
      artifacts.set(a.sha256, a);
    },
    async getArtifact(s) {
      return artifacts.get(s) ?? null;
    },
    async listArtifacts() {
      return [...artifacts.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    async putRun(r) {
      runs.push(r);
      if (runs.length > 500) runs.shift();
    },
    async listRuns(s) {
      return runs.filter((r) => r.sha256 === s);
    },
    async putSession(s) {
      sessions.set(s.sessionId, s);
    },
    async listSessions() {
      return [...sessions.values()].sort((a, b) => b.at - a.at);
    },
    async clear() {
      artifacts.clear();
      runs.length = 0;
      sessions.clear();
    },
  };
}

const DB = "llmtobinary";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Open the IndexedDB store; falls back to memory when IndexedDB is unavailable or fails. */
export async function openStore(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<ArtifactStore> {
  if (!factory) return memoryStore();
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB, DB_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains("artifacts")) d.createObjectStore("artifacts", { keyPath: "sha256" });
        if (!d.objectStoreNames.contains("runs")) d.createObjectStore("runs", { keyPath: "runId" }).createIndex("sha256", "sha256");
        if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "sessionId" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("blocked"));
    });
  } catch {
    return memoryStore();
  }
  const mem = memoryStore();
  const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, fallback: () => Promise<T>): Promise<T> => {
    try {
      return await req(fn(db.transaction(store, mode).objectStore(store)));
    } catch {
      return fallback(); // quota exceeded, eviction, or a transaction failure: degrade to memory
    }
  };
  return {
    persistent: true,
    putArtifact: (a) => tx<IDBValidKey>("artifacts", "readwrite", (s) => s.put(a), () => mem.putArtifact(a).then(() => a.sha256)).then(() => undefined),
    getArtifact: (sha) => tx("artifacts", "readonly", (s) => s.get(sha) as IDBRequest<ArtifactRecord | undefined>, () => mem.getArtifact(sha) as Promise<ArtifactRecord | undefined>).then((x) => x ?? null),
    listArtifacts: () => tx("artifacts", "readonly", (s) => s.getAll() as IDBRequest<ArtifactRecord[]>, () => mem.listArtifacts()).then((xs) => xs.sort((a, b) => b.createdAt - a.createdAt)),
    putRun: (r) => tx<IDBValidKey>("runs", "readwrite", (s) => s.put(r), () => mem.putRun(r).then(() => r.runId)).then(() => undefined),
    listRuns: (sha) => tx("runs", "readonly", (s) => s.index("sha256").getAll(sha) as IDBRequest<RunRecord[]>, () => mem.listRuns(sha)),
    putSession: (x) => tx<IDBValidKey>("sessions", "readwrite", (s) => s.put(x), () => mem.putSession(x).then(() => x.sessionId)).then(() => undefined),
    listSessions: () => tx("sessions", "readonly", (s) => s.getAll() as IDBRequest<SessionRecord[]>, () => mem.listSessions()).then((xs) => xs.sort((a, b) => b.at - a.at)),
    async clear() {
      for (const name of ["artifacts", "runs", "sessions"]) await tx<undefined>(name, "readwrite", (s) => s.clear(), async () => undefined);
      await mem.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest (Section 19) and portable bundles

export interface Manifest {
  manifestVersion: string;
  spec: { id: string; sha256: string };
  build: { commit: string; deploymentId: string | null; policy: string; catalog: string };
  artifact: { sha256: string; byteLength: number; name: string; provenance: Provenance; upstream: string | null };
  annotations: { sha256: string | null; contractLanguage: string };
  generation: {
    sessionId: string | null;
    attemptIds: string[];
    providerResponseIds: string[];
    requestedModel: string | null;
    returnedModels: string[];
    mode: "tools" | "raw-hex" | null;
    promptVersion: string | null;
    outcome: string | null;
    usage: { outputTokens: number; inputTokens: number; unknownUsageTurns: number } | null;
    budgetPolicy: string | null;
    loopTranscriptIncluded: boolean;
    reasoningCarried: boolean | null;
  };
  validation: { ok: boolean; checker: string; taskId: string | null; testReport: TestReport | null; witness: unknown; verification: unknown };
  runs: {
    config: MachineConfig;
    inputs: EntryInput[];
    ticks: TickEvent[];
    returnValue: RunResult["returnValue"];
    terminalSha256: string;
    effectsHash: string;
    framebufferHash: string | null;
    trap: RunResult["trap"];
    counters: RunResult["counters"];
    traceTruncated: boolean;
  }[];
  manualEdits: false;
  assistedConstruction: string;
  exportedAt: string;
}

export interface Bundle {
  bundleVersion: string;
  manifest: Manifest;
  executableBase64: string;
  annotations: unknown;
  task: unknown;
  replay: { inputs: EntryInput[]; ticks: TickEvent[] } | null;
  /** Only present when the visitor opts in: may contain private prompt text. */
  promptHistory?: unknown[];
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ManifestInput {
  specSha256: string;
  buildCommit: string;
  deploymentId: string | null;
  artifact: ArtifactRecord;
  generation?: Partial<Manifest["generation"]>;
  validationOk: boolean;
  checker: string;
  testReport: TestReport | null;
  witness?: unknown;
  /** T3 verification report (prover id, contract owner, outcomes). */
  verification?: unknown;
  runs: { config: MachineConfig; inputs: EntryInput[]; ticks: TickEvent[]; result: RunResult }[];
}

export async function buildManifest(m: ManifestInput): Promise<Manifest> {
  const a = m.artifact;
  const runs = await Promise.all(
    m.runs.map(async (r) => ({
      config: r.config,
      inputs: r.inputs,
      ticks: r.ticks,
      returnValue: r.result.returnValue,
      terminalSha256: await sha256Hex(r.result.terminal),
      effectsHash: r.result.effectsHash,
      framebufferHash: r.result.framebufferHash,
      trap: r.result.trap,
      counters: r.result.counters,
      traceTruncated: r.result.traceTruncated,
    })),
  );
  return {
    manifestVersion: MANIFEST_VERSION,
    spec: { id: SPEC_ID, sha256: m.specSha256 },
    build: { commit: m.buildCommit, deploymentId: m.deploymentId, policy: "fifo-v1", catalog: CATALOG_VERSION },
    artifact: { sha256: a.sha256, byteLength: a.byteLength, name: a.name, provenance: a.provenance, upstream: a.taskId?.startsWith("capstone") || a.taskId?.startsWith("ring-mix") ? "skelpo/llm-to-native-binary@b79649eb9e1d46e6c35d0d2053d19547e9aadd90" : null },
    annotations: { sha256: a.annotationsSha256, contractLanguage: "ANMA-Spec/1" },
    generation: {
      sessionId: null,
      attemptIds: [],
      providerResponseIds: [],
      requestedModel: null,
      returnedModels: [],
      mode: null,
      promptVersion: null,
      outcome: null,
      usage: null,
      budgetPolicy: null,
      loopTranscriptIncluded: false,
      reasoningCarried: null,
      ...m.generation,
    },
    validation: { ok: m.validationOk, checker: m.checker, taskId: a.taskId, testReport: m.testReport, witness: m.witness ?? null, verification: m.verification ?? null },
    runs,
    manualEdits: false,
    assistedConstruction: a.provenance.kind === "model-generated" ? "checker-assisted loop: static diagnostics only; no bytes were produced or repaired by the application" : a.provenance.kind === "bundled-fixture" ? "developer/specification fixture (tool-created or specification bytes), not model output" : "imported file; claims unverified until rerun",
    exportedAt: new Date().toISOString(),
  };
}

export function exportBundle(manifest: Manifest, a: ArtifactRecord, task: unknown, replay: Bundle["replay"], promptHistory?: unknown[]): string {
  const bundle: Bundle = { bundleVersion: BUNDLE_VERSION, manifest, executableBase64: toBase64(a.bytes), annotations: a.annotations, task, replay, ...(promptHistory ? { promptHistory } : {}) };
  return JSON.stringify(bundle, null, 2);
}

export interface ImportResult {
  bytes: Uint8Array;
  sha256: string;
  manifest: Manifest | null;
  annotations: unknown;
  replay: Bundle["replay"];
  warnings: string[];
}

/** Sanitized, bounded import. The executable hash is recomputed; client-provided results are unverified. */
export async function importBundle(text: string, fileName = "import"): Promise<ImportResult> {
  if (text.length > MAX_IMPORT_BUNDLE_BYTES) throw new Error(`bundle exceeds ${MAX_IMPORT_BUNDLE_BYTES} bytes`);
  let b: Partial<Bundle>;
  try {
    b = JSON.parse(text) as Partial<Bundle>;
  } catch {
    throw new Error("the bundle is not valid JSON");
  }
  if (b.bundleVersion !== BUNDLE_VERSION || typeof b.executableBase64 !== "string") throw new Error("not an llmtobinary bundle");
  const bytes = fromBase64(b.executableBase64);
  if (bytes.length > MAX_IMPORT_EXECUTABLE_BYTES) throw new Error(`executable exceeds ${MAX_IMPORT_EXECUTABLE_BYTES} bytes`);
  const sha256 = await sha256Hex(bytes);
  const warnings: string[] = ["Imported results are unverified until you rerun them here."];
  const manifest = (b.manifest ?? null) as Manifest | null;
  if (manifest && manifest.artifact?.sha256 !== sha256) warnings.push(`The manifest names ${String(manifest.artifact?.sha256).slice(0, 16)}… but the bytes hash to ${sha256.slice(0, 16)}…; the bytes win.`);
  const replay = b.replay && Array.isArray(b.replay.inputs) && Array.isArray(b.replay.ticks) ? { inputs: b.replay.inputs.slice(0, 64), ticks: b.replay.ticks.slice(0, 4096) } : null;
  void fileName;
  return { bytes, sha256, manifest, annotations: b.annotations ?? null, replay, warnings };
}
