// The simple view of a program: where it came from, whether it passed the checks, and every
// instruction as raw bytes next to a plain-English reading.

import { useState } from "react";
import type { LoadedArtifact } from "./artifact.ts";
import { plainEnglish } from "./plain.ts";

const hexWord = (b: Uint8Array, at: number) => Array.from(b.subarray(at, at + 4), (x) => x.toString(16).padStart(2, "0")).join(" ");

function origin(a: LoadedArtifact): string {
  const p = a.record.provenance;
  if (p.kind === "model-generated") return `Written by the AI${p.requestedModel ? ` (${p.requestedModel})` : ""}, byte by byte. No compiler was involved.`;
  if (p.kind === "bundled-fixture") return "A reference program made by this project's own tools, for comparison. Not written by the AI.";
  return "Imported from a file. Its origin can't be verified here.";
}

export function BinaryView({ artifact, onExpert }: { artifact: LoadedArtifact | null; onExpert: () => void }) {
  const [all, setAll] = useState(false);
  if (!artifact) {
    return (
      <section className="panel binary-view" aria-label="The binary">
        <h2>2. The binary</h2>
        <p className="muted">Choose or generate a program to see the exact bytes the chip will run.</p>
      </section>
    );
  }
  const bytes = artifact.record.bytes;
  const records = artifact.decoded?.records ?? [];
  const shown = all ? records : records.slice(0, 40);
  const ok = artifact.check.ok;
  const t = artifact.test;
  return (
    <section className="panel binary-view" aria-label="The binary">
      <h2>2. The binary</h2>
      <p className="binary-origin">{origin(artifact)}</p>
      <dl className="binary-facts">
        <dt>Size</dt>
        <dd>
          {bytes.length.toLocaleString()} bytes: a 32-byte header and {records.length.toLocaleString()} instructions of 16 bytes
        </dd>
        <dt>Checked</dt>
        <dd>{ok ? "✓ every instruction is valid ANMA-1" : `✕ ${artifact.check.errors.length} problem(s) found; it cannot run`}</dd>
        {t && (
          <>
            <dt>Tested</dt>
            <dd>
              {t.cases.length === 0 && !artifact.record.taskId
                ? "no tests: a free-form request has no reference answer to check against"
                : t.passed
                  ? artifact.record.taskId
                    ? "✓ passes every test"
                    : "✓ runs, and the examples the AI wrote about it hold"
                  : "✕ some tests fail"}
            </dd>
          </>
        )}
      </dl>
      <ol className="plain-list" aria-label="Instructions">
        {shown.map((r) => (
          <li key={r.index}>
            <span className="plain-idx">{r.index}</span>
            <span className="plain-text">{plainEnglish(r)}</span>
            <code className="plain-hex">{[0, 4, 8, 12].map((k) => hexWord(bytes, r.offset + k)).join("  ")}</code>
          </li>
        ))}
      </ol>
      {records.length > shown.length && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {records.length.toLocaleString()} instructions
        </button>
      )}
      <p className="muted small">
        Want the hex dump, value types, diagnostics and formal verification? <button className="link" onClick={onExpert}>Switch to expert view</button>.
      </p>
    </section>
  );
}
