// Content-addressed registry core (PRD-OS section 6.4 to 6.6). Web-standard APIs only, so the same
// code runs in the Worker, the browser, the verifier and the research CLI.

export const REGISTRY_VERSION = "llmtobinary-registry/1";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytesOfHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type ObjectId = `sha256:${string}`;
export const OBJECT_ID_RE = /^sha256:[0-9a-f]{64}$/;
export const isObjectId = (s: string): s is ObjectId => OBJECT_ID_RE.test(s);

/** An object's identity: SHA-256 over its exact bytes, with the algorithm in the identifier. */
export async function objectId(bytes: Uint8Array): Promise<ObjectId> {
  return `sha256:${hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))}`;
}

/** Canonical JSON: sorted keys, no whitespace, so structured records hash the same everywhere. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export type PredicateType = "provenance" | "validation" | "test" | "proof" | "rerun" | "counterexample" | "retraction";

export interface Statement {
  _type: typeof STATEMENT_TYPE;
  subject: { digest: { sha256: string } }[];
  predicateType: `llmtobinary/${PredicateType}/1`;
  predicate: Record<string, unknown>;
}

export interface Envelope {
  payloadType: typeof DSSE_PAYLOAD_TYPE;
  payload: string;
  signatures: { keyid: string; sig: string }[];
}

export function statement(subject: ObjectId, type: PredicateType, predicate: Record<string, unknown>): Statement {
  return { _type: STATEMENT_TYPE, subject: [{ digest: { sha256: subject.slice(7) } }], predicateType: `llmtobinary/${type}/1`, predicate };
}

/** DSSE pre-authentication encoding. */
function pae(type: string, body: Uint8Array): Uint8Array {
  const head = utf8(`DSSEv1 ${utf8(type).length} ${type} ${body.length} `);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

export interface SigningKey {
  keyid: string;
  privateKey: CryptoKey;
}

export async function generateKeyPair(): Promise<{ publicKeyHex: string; privateKeyPkcs8Hex: string }> {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", k.publicKey)) as ArrayBuffer;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", k.privateKey)) as ArrayBuffer;
  return { publicKeyHex: hexOf(new Uint8Array(raw)), privateKeyPkcs8Hex: hexOf(new Uint8Array(pkcs8)) };
}

export async function importSigningKey(keyid: string, privateKeyPkcs8Hex: string): Promise<SigningKey> {
  return { keyid, privateKey: await crypto.subtle.importKey("pkcs8", bytesOfHex(privateKeyPkcs8Hex) as BufferSource, "Ed25519", false, ["sign"]) };
}

export async function signStatement(s: Statement, key: SigningKey): Promise<Envelope> {
  const body = utf8(canonicalJson(s));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, pae(DSSE_PAYLOAD_TYPE, body) as BufferSource));
  return { payloadType: DSSE_PAYLOAD_TYPE, payload: b64(body), signatures: [{ keyid: key.keyid, sig: b64(sig) }] };
}

/** Roles a key may hold. A key only ever proves what its role allows. */
export type KeyRole = "broker" | "verifier" | "curator";

export interface TrustedKey {
  keyid: string;
  publicKeyHex: string;
  role: KeyRole;
}

export interface VerifiedAttestation {
  statement: Statement;
  keyid: string;
  role: KeyRole;
}

/** Returns the statement only if a trusted key signed exactly these bytes. */
export async function verifyEnvelope(env: Envelope, trust: readonly TrustedKey[]): Promise<VerifiedAttestation | null> {
  if (env.payloadType !== DSSE_PAYLOAD_TYPE) return null;
  let body: Uint8Array;
  try {
    body = unb64(env.payload);
  } catch {
    return null;
  }
  for (const s of env.signatures) {
    const k = trust.find((t) => t.keyid === s.keyid);
    if (!k) continue;
    try {
      const pub = await crypto.subtle.importKey("raw", bytesOfHex(k.publicKeyHex) as BufferSource, "Ed25519", false, ["verify"]);
      if (await crypto.subtle.verify("Ed25519", pub, unb64(s.sig) as BufferSource, pae(env.payloadType, body) as BufferSource)) {
        return { statement: JSON.parse(new TextDecoder().decode(body)) as Statement, keyid: k.keyid, role: k.role };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type EvidenceClass = "E0" | "E1" | "E2" | "E3" | "E4" | "E5";
const ORDER: EvidenceClass[] = ["E0", "E1", "E2", "E3", "E4", "E5"];
export const atLeast = (c: EvidenceClass, floor: EvidenceClass): boolean => ORDER.indexOf(c) >= ORDER.indexOf(floor);

export interface ObservedFacts {
  /** Validated under a named spec by the registry itself. */
  valid: boolean;
  /** Ran and held its own claims, or passed a model-owned or client-reported check. */
  selfConsistent: boolean;
}

export interface Evidence {
  class: EvidenceClass;
  retracted: boolean;
  /** Why the class is what it is, for the package page. */
  basis: string[];
}

/**
 * The evidence class. Self-reported facts reach E2 at most: E3 and above come only from verified
 * attestations signed by a key with the verifier role, so no outcome string, browser result, star
 * or comment can raise a package past E2.
 */
export function classify(subject: ObjectId, facts: ObservedFacts, attestations: readonly VerifiedAttestation[]): Evidence {
  const sha = subject.slice(7);
  const about = attestations.filter((a) => a.statement.subject.some((s) => s.digest.sha256 === sha));
  const verifier = about.filter((a) => a.role === "verifier");
  const basis: string[] = [];
  let cls: EvidenceClass = "E0";
  if (facts.valid) cls = "E1";
  if (facts.valid && facts.selfConsistent) {
    cls = "E2";
    basis.push("held its own claims");
  }
  const tests = verifier.filter((a) => a.statement.predicateType === "llmtobinary/test/1" && a.statement.predicate.passed === true && a.statement.predicate.taskOwned === true && a.statement.predicate.holdouts === true);
  const counterexamples = verifier.filter((a) => a.statement.predicateType === "llmtobinary/counterexample/1" && a.statement.predicate.confirmed === true);
  const retractions = about.filter((a) => a.statement.predicateType === "llmtobinary/retraction/1" && (a.role === "curator" || a.role === "verifier"));
  if (facts.valid && tests.length && !counterexamples.length) {
    cls = "E3";
    basis.push(`passed task-owned tests (verifier ${tests[0]!.keyid})`);
    const first = tests[0]!.statement.predicate.outputHash;
    const second = verifier.find((a) => a.statement.predicateType === "llmtobinary/rerun/1" && a.keyid !== tests[0]!.keyid && a.statement.predicate.outputHash === first);
    if (second) {
      cls = "E4";
      basis.push(`rerun matched bit for bit (verifier ${second.keyid})`);
    }
    const proof = verifier.find((a) => a.statement.predicateType === "llmtobinary/proof/1" && a.statement.predicate.taskOwned === true && a.statement.predicate.adequate === true);
    if (proof) {
      cls = "E5";
      basis.push("proved against a task-owned contract, adequacy checks passed");
    }
  }
  if (counterexamples.length) basis.push(`demoted: ${counterexamples.length} confirmed counterexample(s)`);
  return { class: cls, retracted: retractions.length > 0 || counterexamples.length > 0, basis };
}

export interface LogEntry {
  seq: number;
  prev: string;
  at: number;
  kind: "publish" | "attest" | "bind-name" | "retract" | "takedown";
  subject: string;
  detail: Record<string, unknown>;
  hash: string;
}

export const LOG_GENESIS = "0".repeat(64);

export async function appendLog(prev: LogEntry | null, e: Pick<LogEntry, "at" | "kind" | "subject" | "detail">): Promise<LogEntry> {
  const body = { seq: prev ? prev.seq + 1 : 0, prev: prev ? prev.hash : LOG_GENESIS, at: e.at, kind: e.kind, subject: e.subject, detail: e.detail };
  return { ...body, hash: (await objectId(utf8(canonicalJson(body)))).slice(7) };
}

/** Finds the first entry that breaks the chain, or returns -1 when the whole log verifies. */
export async function verifyLog(entries: readonly LogEntry[]): Promise<number> {
  let prev: LogEntry | null = null;
  for (const [i, e] of entries.entries()) {
    const want = await appendLog(prev, e);
    if (want.hash !== e.hash || want.seq !== e.seq || want.prev !== e.prev) return i;
    prev = e;
  }
  return -1;
}

export interface LockFile {
  kind: "llmtobinary-lock/1";
  root: ObjectId;
  specDigest: string;
  engineDigest: string;
  policy: { minimumClass: EvidenceClass };
  slots: Record<string, ObjectId>;
}

export type LockProblem = { slot: string; problem: "unknown-object" | "not-an-id" | "below-policy" | "retracted" | "taken-down" };

/** Fails closed: every pin must resolve, meet policy and not be retracted. */
export function checkLock(lock: LockFile, resolve: (id: ObjectId) => { evidence: Evidence; takenDown: boolean } | null): LockProblem[] {
  const out: LockProblem[] = [];
  for (const [slot, id] of Object.entries(lock.slots)) {
    if (!isObjectId(id)) {
      out.push({ slot, problem: "not-an-id" });
      continue;
    }
    const r = resolve(id);
    if (!r) out.push({ slot, problem: "unknown-object" });
    else if (r.takenDown) out.push({ slot, problem: "taken-down" });
    else if (r.evidence.retracted) out.push({ slot, problem: "retracted" });
    else if (!atLeast(r.evidence.class, lock.policy.minimumClass)) out.push({ slot, problem: "below-policy" });
  }
  return out;
}
