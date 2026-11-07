// The community pages: registry, package and profile. Every string from people or models renders as
// plain text through React. The evidence class is a label, never blended with stars or comments.

import { useEffect, useState, type FormEvent } from "react";
import "./community.css";

interface PackageRow {
  object_id: string;
  label: string;
  prompt: string;
  task_id: string | null;
  outcome: string;
  model: string;
  records: number;
  byte_length: number;
  gallery_id: string | null;
  author_login?: string | null;
  licence: string;
  backfilled: number;
  evidence_class: string;
  retracted: number;
  taken_down: number;
  created_at: number;
  stars?: number;
}

interface Attestation {
  predicateType: string | null;
  keyid: string | null;
  verified: boolean;
}

interface Comment {
  id: string;
  body: string;
  createdAt: number;
  author: string | null;
}

interface Member {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

const EVIDENCE: Record<string, string> = {
  E0: "Archived: bytes exist, possibly invalid",
  E1: "Valid: passes the validator",
  E2: "Self-consistent: held its own claims, not independently tested",
  E3: "Task-tested: the verifier passed it on accepted tests",
  E4: "Re-verified: a second verifier matched it bit for bit",
  E5: "Proved against a task-owned contract",
};

const shortId = (id: string): string => id.slice(7, 19);
const when = (t: number): string => new Date(t).toISOString().slice(0, 10);

async function send(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

function useMember(): { member: Member | null; ready: boolean; accounts: boolean } {
  const [state, setState] = useState<{ member: Member | null; ready: boolean; accounts: boolean }>({ member: null, ready: false, accounts: false });
  useEffect(() => {
    void Promise.all([fetch("/api/me").then((r) => r.json()).catch(() => ({ member: null })), fetch("/api/config").then((r) => r.json()).catch(() => ({}))]).then(([me, cfg]) => setState({ member: (me as { member: Member | null }).member, ready: true, accounts: !!(cfg as { accounts?: boolean }).accounts }));
  }, []);
  return state;
}

function Evidence({ value, retracted }: { value: string; retracted?: boolean }) {
  return (
    <span className={`evidence evidence-${value}`} title={EVIDENCE[value]}>
      {value}
      {retracted ? " retracted" : ""}
    </span>
  );
}

function Bar() {
  const { member, ready, accounts } = useMember();
  const signOut = async () => {
    await send("/api/auth/logout", { method: "POST" });
    location.reload();
  };
  return (
    <nav className="community-bar" aria-label="Community">
      <a className="community-brand" href="/">llmtobinary</a>
      <a href="/registry">Registry</a>
      <a href="/os">OS board</a>
      <a href="/compose">Compose</a>
      <a href="/boot">Boot</a>
      <span className="community-spacer" />
      {ready && member ? (
        <>
          <a href={`/u/${encodeURIComponent(member.login)}`}>{member.login}</a>
          <button onClick={() => void signOut()}>Sign out</button>
        </>
      ) : ready && accounts ? (
        <a href="/api/auth/github">Sign in with GitHub</a>
      ) : null}
    </nav>
  );
}

function PackageList({ author }: { author?: string }) {
  const [items, setItems] = useState<PackageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cls, setCls] = useState("");
  const [before, setBefore] = useState<number | null>(null);

  const load = async (more: number | null) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (cls) p.set("class", cls);
    if (author) p.set("author", author);
    if (more !== null) p.set("before", String(more));
    const res = await fetch(`/api/registry?${p}`);
    if (!res.ok) {
      setError(res.status === 503 ? "The registry is not available yet." : "The registry could not be loaded.");
      setItems((prev) => prev ?? []);
      return;
    }
    const b = (await res.json()) as { items: PackageRow[]; before: number | null };
    setError(null);
    setItems((prev) => (more !== null ? [...(prev ?? []), ...b.items] : b.items));
    setBefore(b.before);
  };

  useEffect(() => {
    void load(null);
    // Filters apply on submit or on choosing a class.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cls, author]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void load(null);
  };

  return (
    <>
      <form className="community-search" onSubmit={submit} role="search">
        <input aria-label="Search programs" placeholder="Search prompts and labels" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Evidence class" value={cls} onChange={(e) => setCls(e.target.value)}>
          <option value="">Any evidence</option>
          {Object.entries(EVIDENCE).map(([k, v]) => (
            <option key={k} value={k}>
              {k}: {v.split(":")[0]}
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {items === null ? <p className="muted">Loading…</p> : null}
      {items?.length === 0 && !error ? <p className="muted">No programs match.</p> : null}
      <ul className="package-list">
        {items?.map((p) => (
          <li key={p.object_id}>
            <a href={`/package/${p.object_id}`}>{p.label || shortId(p.object_id)}</a>
            <Evidence value={p.evidence_class} retracted={!!p.retracted} />
            <p className="package-prompt">{p.prompt}</p>
            <p className="muted small">
              {p.records} records · {p.model} · {p.author_login ?? "anonymous"} · {when(p.created_at)} · {p.stars ?? 0} stars
            </p>
          </li>
        ))}
      </ul>
      {before !== null ? <button onClick={() => void load(before)}>Load older</button> : null}
    </>
  );
}

interface SlotView {
  id: string;
  title: string;
  kind: string;
  depends: string;
  candidates: number;
  open: boolean;
  winner: { object_id: string; evidence_class: string; records: number } | null;
}

function generateMessage(status: number, error: string): string {
  if (status === 401) return "Sign in with GitHub to generate.";
  if (status === 429) return error;
  return error || "The generation could not start.";
}

/** Runs one generation for a slot, and follows it until the model submits. */
function SlotGenerate({ slot, onDone }: { slot: SlotView; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setNote("Starting…");
    try {
      const res = await send("/api/generation-sessions", { method: "POST", body: JSON.stringify({ slot: slot.id }) });
      const created = (await res.json()) as { sessionId?: string; token?: string; error?: string };
      if (!res.ok || !created.sessionId || !created.token) {
        setNote(generateMessage(res.status, created.error ?? ""));
        return;
      }
      setNote("A model is writing the bytes…");
      const run = await send(`/api/generation-sessions/${created.sessionId}/attempts`, { method: "POST", headers: { authorization: `Bearer ${created.token}` }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), feedback: null }) });
      const reader = run.body?.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let submitted = false;
      let stopped: string | null = null;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        text = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          const e = JSON.parse(l) as { type?: string; turn?: number; detail?: string };
          if (e.type === "turn.started") setNote(`A model is writing the bytes (turn ${e.turn})…`);
          if (e.type === "candidate.submitted") submitted = true;
          if (e.type === "loop.stopped") stopped = e.detail ?? "It stopped.";
        }
      }
      setNote(submitted ? "Submitted. The verifier will test it, and its evidence will appear here." : (stopped ?? "The model did not submit a program."));
      onDone();
    } catch {
      setNote("The connection was lost. Closing this tab also ends a generation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button disabled={busy} onClick={() => void start()}>Generate</button>
      {note ? <span className="muted small" role="status"> {note}</span> : null}
    </>
  );
}

function Board() {
  const [slots, setSlots] = useState<SlotView[] | null>(null);
  const [error, setError] = useState(false);
  const load = async () => {
    const res = await fetch("/api/slots");
    if (!res.ok) {
      setError(true);
      return;
    }
    setSlots(((await res.json()) as { slots: SlotView[] }).slots);
  };
  useEffect(() => void load(), []);
  if (error) return <p role="alert">The OS board is not available yet.</p>;
  if (!slots) return <p className="muted">Loading…</p>;
  const done = slots.filter((s) => !s.open).length;
  return (
    <>
      <p className="muted">The operating system is split into small packages. Anyone can pick a slot and have a model write it. A slot is filled once a candidate passes independently held tests, and the default candidate is chosen by evidence, then size, then age, never by popularity.</p>
      <p>{done} of {slots.length} slots filled. <a href="/boot">Boot the OS</a></p>
      <ul className="package-list">
        {slots.map((s) => (
          <li key={s.id}>
            <strong>{s.title}</strong> {s.winner ? <Evidence value={s.winner.evidence_class} /> : <span className="evidence">open</span>}
            <p className="muted small">
              {s.kind} · {s.candidates} candidate{s.candidates === 1 ? "" : "s"}
              {JSON.parse(s.depends).length ? ` · needs ${(JSON.parse(s.depends) as string[]).join(", ")}` : ""}
              {s.winner ? <> · <a href={`/package/${s.winner.object_id}`}>{s.winner.records} records</a></> : null}
            </p>
            <SlotGenerate slot={s} onDone={() => void load()} />
          </li>
        ))}
      </ul>
    </>
  );
}

interface SlotDetail {
  id: string;
  kind: string;
  depends: string;
  interface: string;
}
interface Pick {
  slot: SlotDetail;
  candidates: { object_id: string; evidence_class: string; records: number }[];
  chosen: string;
}
interface ExportCard {
  symbol: string;
  id: number;
}

/** Choose a candidate per slot, link in this browser, and publish the result as a build. */
function Compose() {
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/slots");
      if (!res.ok) return setNote("The OS board is not available yet.");
      const { slots } = (await res.json()) as { slots: (SlotView & { winner: { object_id: string } | null })[] };
      const out: Pick[] = [];
      for (const s of slots) {
        const d = (await (await fetch(`/api/slots/${s.id}`)).json()) as { slot: SlotDetail; candidates: Pick["candidates"] };
        out.push({ slot: d.slot, candidates: d.candidates, chosen: s.winner?.object_id ?? d.candidates[0]?.object_id ?? "" });
      }
      setPicks(out);
    })();
  }, []);

  const plan = async () => {
    const { parseModule } = await import("@llmtobinary/module");
    const { link } = await import("@llmtobinary/link");
    const libs = picks!.filter((p) => p.slot.kind !== "program");
    const exportsOf = (s: SlotDetail): ExportCard[] => JSON.parse(s.interface) as ExportCard[];
    const bySlot = new Map(picks!.map((p) => [p.slot.id, p]));
    const modules: { slot: string; exports: Record<string, number>; imports: Record<string, string> }[] = [];
    const inputs = [];
    for (const p of [...libs].sort((a) => (a.slot.kind === "root" ? -1 : 1))) {
      const res = await fetch(`/api/registry/${p.chosen}/bytes`);
      if (!res.ok) throw new Error(`${p.slot.id} has no bytes`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const parsed = parseModule(bytes);
      if (!parsed.ok) throw new Error(`${p.slot.id}: ${parsed.error.message}`);
      const wanted = (JSON.parse(p.slot.depends) as string[]).flatMap((d) => exportsOf(bySlot.get(d)!.slot));
      const first = parsed.module.functions.length;
      const imports = Object.fromEntries(wanted.slice(0, parsed.module.imports.length).map((e, k) => [String(first + k), e.symbol]));
      const exports = Object.fromEntries(exportsOf(p.slot).map((e) => [e.symbol, e.id]));
      modules.push({ slot: p.slot.id, exports, imports });
      inputs.push({ name: p.slot.id, bytes, exports, imports: Object.fromEntries(Object.entries(imports).map(([k, v]) => [Number(k), v])) });
    }
    return { modules, linked: link(inputs) };
  };

  const check = async () => {
    setNote("Linking…");
    try {
      const { linked } = await plan();
      setNote(linked.ok ? `Linked: ${(linked.bytes.length - 32) / 16} records. The image can use ${linked.authority.join(", ")}.` : linked.errors.map((e) => e.message).join(" "));
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const publish = async () => {
    setNote("Publishing…");
    try {
      const { modules, linked } = await plan();
      if (!linked.ok) return setNote(linked.errors.map((e) => e.message).join(" "));
      const slots = Object.fromEntries(picks!.map((p) => [p.slot.id, p.chosen]));
      const root = picks!.find((p) => p.slot.kind === "root")!.chosen;
      const res = await send("/api/builds", { method: "POST", body: JSON.stringify({ name, modules, lock: { kind: "llmtobinary-lock/1", root, specDigest: "anma-2", engineDigest: "reference", policy: { minimumClass: "E3" }, slots } }) });
      const b = (await res.json()) as { image?: string; error?: string };
      if (!res.ok || !b.image) return setNote(b.error ?? "The build was refused.");
      setImage(b.image);
      setNote("Published. The server linked and validated it again.");
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  if (!picks) return <p className="muted">{note ?? "Loading…"}</p>;
  return (
    <>
      <p className="muted">Choose a candidate for each slot. Linking happens in your browser, then the server repeats it, so a forged image cannot be published. A published build accepts only packages that passed independently held tests.</p>
      {picks.map((p, i) => (
        <p key={p.slot.id}>
          <label>
            {p.slot.id}{" "}
            <select value={p.chosen} onChange={(e) => setPicks(picks.map((x, k) => (k === i ? { ...x, chosen: e.target.value } : x)))}>
              {p.candidates.map((c) => (
                <option key={c.object_id} value={c.object_id}>
                  {c.evidence_class} · {c.records} records · {c.object_id.slice(7, 15)}
                </option>
              ))}
            </select>
          </label>
        </p>
      ))}
      <div className="package-actions">
        <button onClick={() => void check()}>Link</button>
        <input aria-label="Build name" placeholder="Build name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={() => void publish()}>Publish build</button>
        {image ? <a className="action" href={`/boot?image=${image}`}>Boot this build</a> : null}
      </div>
      {note ? <p role="status">{note}</p> : null}
    </>
  );
}

function PackagePage({ id }: { id: string }) {
  const { member, accounts } = useMember();
  const [data, setData] = useState<{ package: PackageRow; attestations: Attestation[]; comments: Comment[]; slot: { id: string; kind: string; interface: string; depends: string } | null } | null | "missing">(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/registry/${id}`);
    setData(res.ok ? ((await res.json()) as never) : "missing");
  };
  useEffect(() => void load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (data === null) return <p className="muted">Loading…</p>;
  if (data === "missing") return <p role="alert">This object is not in the registry.</p>;
  const p = data.package;

  const star = async () => {
    await send(`/api/registry/${id}/star`, { method: "PUT" });
    await load();
  };
  const comment = async (e: FormEvent) => {
    e.preventDefault();
    const res = await send(`/api/registry/${id}/comments`, { method: "POST", body: JSON.stringify({ body: draft }) });
    if (res.ok) {
      setDraft("");
      await load();
    } else setNote(((await res.json()) as { error?: string }).error ?? "The comment could not be posted.");
  };
  const breakIt = async () => {
    const input = prompt("What input makes this package break its contract? The verifier will rerun it.");
    if (!input?.trim()) return;
    const res = await send(`/api/registry/${id}/counterexamples`, { method: "POST", body: JSON.stringify({ input }) });
    setNote(res.ok ? "Submitted. The verifier will check it against the oracle." : "It could not be submitted.");
  };
  const report = async () => {
    const reason = prompt("What is wrong with this program?");
    if (!reason?.trim()) return;
    const res = await send("/api/reports", { method: "POST", body: JSON.stringify({ target: id, reason }) });
    setNote(res.ok ? "Thanks. A curator will look at it." : "The report could not be sent.");
  };

  if (p.taken_down) return <p role="alert">This program was taken down. Its hash stays in the public log.</p>;
  return (
    <article className="package-page">
      <h1>{p.label || shortId(id)}</h1>
      <p>
        <Evidence value={p.evidence_class} retracted={!!p.retracted} /> <span className="muted">{EVIDENCE[p.evidence_class]}</span>
      </p>
      {p.evidence_class === "E2" ? <p className="warn-note">No independent test has confirmed this program. Pin it knowingly.</p> : null}
      <h2>Prompt</h2>
      <p className="package-prompt-full">{p.prompt}</p>
      <dl className="package-facts">
        <dt>Identity</dt>
        <dd className="mono">{id}</dd>
        <dt>Outcome</dt>
        <dd>{p.outcome}</dd>
        <dt>Size</dt>
        <dd>{p.records} records, {p.byte_length} bytes</dd>
        <dt>Model</dt>
        <dd>{p.model}</dd>
        <dt>Author</dt>
        <dd>{p.author_login ? <a href={`/u/${encodeURIComponent(p.author_login)}`}>{p.author_login}</a> : "anonymous"}</dd>
        <dt>Licence</dt>
        <dd>{p.licence}{p.backfilled ? " (archived before the registry existed)" : ""}</dd>
      </dl>
      <div className="package-actions">
        {p.gallery_id ? <a className="action" href={`/?program=${encodeURIComponent(p.gallery_id)}`}>Open and run</a> : null}
        <a className="action" href={`/api/registry/${id}/bytes`} download>Download bytes</a>
        {member ? <button onClick={() => void star()}>Star ({p.stars ?? 0})</button> : <span className="muted">{p.stars ?? 0} stars</span>}
        {member ? <button onClick={() => void breakIt()}>Break this package</button> : null}
        <button onClick={() => void report()}>Report</button>
      </div>
      {note ? <p role="status">{note}</p> : null}
      {data.slot ? (
        <>
          <h2>Documentation</h2>
          <p className="muted small">Rendered from the {data.slot.id} slot's interface, not written by the model. {["E3", "E4", "E5"].includes(p.evidence_class) ? "Each function below was checked by the verifier's tests." : "These are the requirements. This candidate has not been verified against them yet."}</p>
          {(JSON.parse(data.slot.interface) as { symbol: string; signature: string; behaviour: string }[]).map((e) => (
            <div key={e.symbol} className="package-doc">
              <code>{e.symbol}{e.signature}</code>
              <p>{e.behaviour}</p>
            </div>
          ))}
          {(JSON.parse(data.slot.depends) as string[]).length ? <p className="muted small">Links with: {(JSON.parse(data.slot.depends) as string[]).join(", ")}</p> : null}
        </>
      ) : null}
      <h2>Evidence</h2>
      {data.attestations.length ? (
        <ul>
          {data.attestations.map((a, i) => (
            <li key={i}>
              {a.verified ? `${a.predicateType} signed by ${a.keyid}` : "Unverified attestation (ignored)"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No signed attestations yet.</p>
      )}
      <h2>Comments</h2>
      {data.comments.map((c) => (
        <div className="comment" key={c.id}>
          <p className="muted small">{c.author ?? "deleted user"} · {when(c.createdAt)}</p>
          <p>{c.body}</p>
        </div>
      ))}
      {member ? (
        <form onSubmit={(e) => void comment(e)}>
          <textarea aria-label="Comment" value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" disabled={!draft.trim()}>Comment</button>
        </form>
      ) : accounts ? (
        <p className="muted"><a href="/api/auth/github">Sign in with GitHub</a> to comment.</p>
      ) : null}
    </article>
  );
}

export function Community() {
  // The asset server redirects /package/sha256:… to its percent-encoded form.
  const path = decodeURIComponent(location.pathname);
  const pkg = /^\/package\/(sha256:[0-9a-f]{64})$/.exec(path);
  const user = /^\/u\/([^/]+)$/.exec(path);
  return (
    <div className="community">
      <Bar />
      <main className="community-main">
        {pkg ? (
          <PackagePage id={pkg[1]!} />
        ) : path === "/compose" ? (
          <>
            <h1>Compose a build</h1>
            <Compose />
          </>
        ) : path === "/os" ? (
          <>
            <h1>OS board</h1>
            <Board />
          </>
        ) : user ? (
          <>
            <h1>{decodeURIComponent(user[1]!)}</h1>
            <PackageList author={decodeURIComponent(user[1]!)} />
          </>
        ) : (
          <>
            <h1>Registry</h1>
            <p className="muted">Every program anyone has generated here, working or not. Evidence classes come only from signed checks, never from popularity.</p>
            <PackageList />
          </>
        )}
      </main>
    </div>
  );
}
