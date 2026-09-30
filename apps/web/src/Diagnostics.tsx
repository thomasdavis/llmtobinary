import type { Diagnostic } from "@llmtobinary/diagnostics";

export function DiagnosticItem({ d }: { d: Diagnostic }) {
  return (
    <li className={`diag diag-${d.severity}`}>
      <div className="diag-head">
        <span className="badge">{d.severity === "error" ? "✕ error" : "! warning"}</span> <code>{d.rule}</code> <span className="muted">{d.category}</span>
        {d.location.recordIndex !== null && <span className="muted"> · record {d.location.recordIndex}</span>}
        {d.location.byteOffset !== null && <span className="muted"> · byte {d.location.byteOffset}</span>}
      </div>
      <div>{d.message}</div>
      {d.found && <div className="kv"><span>found</span><code>{d.found}</code></div>}
      {d.expected && <div className="kv"><span>expected</span><code>{d.expected}</code></div>}
      {d.derived && <div className="kv"><span>derived</span><span>{d.derived}</span></div>}
      {d.claim && <div className="kv"><span>model's claim</span><code>{d.claim}</code></div>}
      {d.context && <pre className="context">{d.context}</pre>}
    </li>
  );
}

export function DiagnosticList({ items, empty }: { items: readonly Diagnostic[]; empty?: string }) {
  if (!items.length) return empty ? <p className="muted">{empty}</p> : null;
  return <ul className="diags">{items.map((d, i) => <DiagnosticItem key={`${d.rule}-${i}`} d={d} />)}</ul>;
}
