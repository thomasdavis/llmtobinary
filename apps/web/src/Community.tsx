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

function PackagePage({ id }: { id: string }) {
  const { member, accounts } = useMember();
  const [data, setData] = useState<{ package: PackageRow; attestations: Attestation[]; comments: Comment[] } | null | "missing">(null);
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
        <button onClick={() => void report()}>Report</button>
      </div>
      {note ? <p role="status">{note}</p> : null}
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
  const path = location.pathname;
  const pkg = /^\/package\/(sha256:[0-9a-f]{64})$/.exec(path);
  const user = /^\/u\/([^/]+)$/.exec(path);
  return (
    <div className="community">
      <Bar />
      <main className="community-main">
        {pkg ? (
          <PackagePage id={pkg[1]!} />
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
