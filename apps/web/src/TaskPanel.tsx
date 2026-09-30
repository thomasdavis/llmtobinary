import { useEffect, useState } from "react";
import { Feature } from "@llmtobinary/spec";
import { TASKS, TASK_BY_ID, signatureText } from "@llmtobinary/tasks/registry";
import type { CreateSessionRequest, LoopEvent } from "@llmtobinary/protocol";
import type { ArtifactRecord } from "@llmtobinary/artifacts";
import type { Config } from "./api.ts";
import { FIXTURES } from "./fixtures.ts";
import type { GenState, SubmittedCandidate } from "./generation.ts";
import { DiagnosticList } from "./Diagnostics.tsx";

const MAX_DESCRIPTION = 16_000;
const MAX_INPUTS = 8;
const DRAFT_KEY = "llmtobinary.customPrompt.v1";

interface Draft {
  description: string;
  params: ("u64" | "bool")[];
  returns: "unit" | "u64" | "bool";
  features: number;
}

function loadDraft(): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Draft | null;
    return d && typeof d.description === "string" && Array.isArray(d.params) ? d : null;
  } catch {
    return null;
  }
}

const DEVICES: [number, string][] = [
  [Feature.TERMINAL, "terminal"],
  [Feature.FRAMEBUFFER, "framebuffer"],
  [Feature.INPUT, "event input"],
  [Feature.HEAP, "typed heap"],
];

export function TaskPanel(props: {
  config: Config | null;
  configError: string | null;
  gen: GenState;
  history: ArtifactRecord[];
  onFixture: (file: string, task: string) => void;
  onGenerate: (req: CreateSessionRequest) => void;
  onCancel: () => void;
  onSelectSubmission: (c: SubmittedCandidate) => void;
  onSelectHistory: (a: ArtifactRecord) => void;
  onImport: (f: File) => void;
  onExport: (withPrompts: boolean) => void;
  onDownload: (kind: "anma" | "hex") => void;
  onClearHistory: () => void;
  hasArtifact: boolean;
}) {
  const draft = useState(loadDraft)[0];
  const [source, setSource] = useState<"task" | "custom">(draft?.description.trim() ? "custom" : "task");
  const [taskId, setTaskId] = useState<string>("square-plus-two");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [params, setParams] = useState<("u64" | "bool")[]>(draft?.params ?? ["u64"]);
  const [returns, setReturns] = useState<"unit" | "u64" | "bool">(draft?.returns ?? "u64");
  const [features, setFeatures] = useState<number>(draft?.features ?? Feature.TERMINAL);
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ description, params, returns, features } satisfies Draft));
    } catch {
      /* storage unavailable: the draft just is not remembered */
    }
  }, [description, params, returns, features]);
  const [requireClaims, setRequireClaims] = useState(false);
  const [mode, setMode] = useState<"tools" | "raw-hex">("tools");
  const [consent, setConsent] = useState(false);
  const [withPrompts, setWithPrompts] = useState(false);
  const live = !!props.config?.liveGeneration;
  const task = source === "custom" ? null : TASK_BY_ID.get(taskId) ?? null;
  const allowed = props.config?.allowedFeatures ?? 15;
  const editAsCustom = () => {
    if (!task) return;
    setDescription(task.prompt);
    setParams([...task.params]);
    setReturns(task.returns);
    setFeatures(task.features & allowed);
    setSource("custom");
  };
  const busy = props.gen.phase === "creating" || props.gen.phase === "streaming" || props.gen.phase === "testing";
  const request = (): CreateSessionRequest =>
    task
      ? { task: { taskId: task.id, description: null, params: task.params, returns: task.returns, allowedFeatures: task.features, requireClaims }, mode, profile: "default" }
      : { task: { taskId: null, description, params, returns, allowedFeatures: features & (props.config?.allowedFeatures ?? 15), requireClaims }, mode, profile: "default" };
  const b = props.config?.budget;
  return (
    <section className="panel" aria-label="Task">
      <h2>Program</h2>
      <details open>
        <summary>Run a bundled fixture</summary>
        <p className="muted small">Bundled fixtures are specification- or tool-created bytes — not model output.</p>
        <ul className="fixtures">
          {FIXTURES.map((f) => (
            <li key={f.file}><button className="link" onClick={() => props.onFixture(f.file, f.task)}>{f.file}</button> <span className="muted small">{f.bytes} B · {f.provenance.kind === "specification-fixture" ? "PRD fixture" : "tool-created"}</span></li>
          ))}
        </ul>
      </details>

      <h3>Generate with OpenAI</h3>
      {!live && <p className="notice">Live generation is unavailable here{props.config?.liveReason ? `: ${props.config.liveReason}` : props.configError ? `: ${props.configError}` : ""}. Fixtures and saved artifacts still run in your browser.</p>}
      <div className="segmented" role="radiogroup" aria-label="What to generate">
        <button role="radio" aria-checked={source === "task"} className={source === "task" ? "on" : ""} onClick={() => setSource("task")}>Pick a task</button>
        <button role="radio" aria-checked={source === "custom"} className={source === "custom" ? "on" : ""} onClick={() => setSource("custom")}>Write your own</button>
      </div>
      {source === "task" ? (
        <div className="taskbox">
          <label className="field">
            <span>task</span>
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              {TASKS.filter((t) => t.tier === "public").map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              <optgroup label="research">{TASKS.filter((t) => t.tier === "research").map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</optgroup>
            </select>
          </label>
          {task && (
            <>
              <pre className="prompt">{task.prompt}</pre>
              <p className="small">Entry: <code>{signatureText(task.params, task.returns, task.paramNames)}</code></p>
              <button className="link" onClick={editAsCustom}>Edit as my own prompt</button>
            </>
          )}
        </div>
      ) : (
        <div className="taskbox">
          <label className="field">
            <span>your prompt</span>
            <textarea className="custom-prompt" rows={9} maxLength={MAX_DESCRIPTION} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={"Describe the program. For example:\nReturn the sum of the decimal digits of n.\nor: Draw a bouncing square; Left and Right move it; return the number of bounces when Escape is pressed."} />
          </label>
          <p className="muted small counter">{description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}</p>
          <fieldset>
            <legend>entry function</legend>
            <div className="row wrap">
              {params.map((p, i) => (
                <span key={i} className="param">
                  <select aria-label={`input ${i} type`} value={p} onChange={(e) => setParams(params.map((q, k) => (k === i ? (e.target.value as "u64" | "bool") : q)))}>
                    <option value="u64">u64</option>
                    <option value="bool">bool</option>
                  </select>
                  <button className="icon" aria-label={`remove input ${i}`} onClick={() => setParams(params.filter((_, k) => k !== i))}>×</button>
                </span>
              ))}
              <button onClick={() => setParams([...params, "u64"])} disabled={params.length >= MAX_INPUTS}>+ input</button>
              <label className="field inline"><span>returns</span>
                <select value={returns} onChange={(e) => setReturns(e.target.value as "unit" | "u64" | "bool")}><option>u64</option><option>bool</option><option>unit</option></select>
              </label>
            </div>
            <p className="small">Entry: <code>{signatureText(params, returns)}</code></p>
          </fieldset>
          <fieldset><legend>devices it may use</legend>
            {DEVICES.filter(([bit]) => (allowed & bit) !== 0).map(([bit, name]) => (
              <label key={bit} className="check"><input type="checkbox" checked={(features & bit) !== 0} onChange={(e) => setFeatures(e.target.checked ? features | bit : features & ~bit)} /> {name}</label>
            ))}
          </fieldset>
          <p className="muted small">Your own prompts have no reference answer to test against: a program that validates and runs is labelled “executed; intent not independently verified”. Run it in the machine panel to see what it does.</p>
        </div>
      )}
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={requireClaims} onChange={(e) => setRequireClaims(e.target.checked)} /> require record claims (annotated)</label>
        <label className="field"><span>output mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as "tools" | "raw-hex")}><option value="tools">Literal bytes · checker-assisted loop</option><option value="raw-hex">Raw hex (research profile)</option></select>
        </label>
      </div>
      {b && <p className="small muted">Budget per session: {b.maxTurns} turns · {b.maxChecks} checks · {b.maxSubmissions} submissions · {b.maxOutputTokensPerSession.toLocaleString()} output tokens · {Math.round(b.maxWallClockMs / 60000)} min. Model: {props.config?.profiles[0]?.label ?? "not configured"}{source === "custom" && props.config?.profiles[0]?.openTaskReasoningEffort && props.config.profiles[0].openTaskReasoningEffort !== props.config.profiles[0].reasoningEffort ? `; your own prompts use ${props.config.profiles[0].openTaskReasoningEffort} reasoning` : ""}.</p>}
      <label className="check consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I understand my task text and any failing test results are sent through this site's Cloudflare-hosted server to OpenAI. Runtime inputs are not sent.</label>
      <div className="row">
        <button className="primary" disabled={!live || !consent || busy || (!task && !description.trim())} onClick={() => props.onGenerate(request())}>Generate</button>
        <button onClick={props.onCancel} disabled={!busy}>Cancel generation</button>
      </div>
      <GenerationView gen={props.gen} onSelect={props.onSelectSubmission} />

      <h3>Artifacts</h3>
      <div className="row wrap">
        <label className="button">Import…<input type="file" accept=".json,.anma,.hex,.txt" hidden onChange={(e) => e.target.files?.[0] && props.onImport(e.target.files[0])} /></label>
        <button disabled={!props.hasArtifact} onClick={() => props.onExport(withPrompts)}>Export bundle</button>
        <button disabled={!props.hasArtifact} onClick={() => props.onDownload("anma")}>.anma</button>
        <button disabled={!props.hasArtifact} onClick={() => props.onDownload("hex")}>.hex</button>
      </div>
      <label className="check small"><input type="checkbox" checked={withPrompts} onChange={(e) => setWithPrompts(e.target.checked)} /> include prompt history in exports (may contain private text)</label>
      {props.history.length > 0 && (
        <ul className="history">
          {props.history.slice(0, 30).map((h) => (
            <li key={h.sha256}><button className="link" onClick={() => props.onSelectHistory(h)}>{h.name}</button> <span className="muted small">{h.sha256.slice(0, 12)}… · {h.provenance.kind} · {h.status}</span></li>
          ))}
        </ul>
      )}
      <button className="danger" onClick={props.onClearHistory}>Clear local history</button>
    </section>
  );
}

function outcomeText(o: string | null): string {
  switch (o) {
    case "passed": return "✓ passed — validated and every task test passed in your browser";
    case "passed-unverified": return "✓ executed; intent not independently verified";
    case "budget-exhausted": return "■ stopped: budget exhausted";
    case "stalled": return "■ stopped: stalled (repeating the same candidate or errors)";
    case "refused": return "■ stopped: the model refused";
    case "cancelled": return "■ cancelled";
    case "infrastructure-error": return "✕ infrastructure error (not a model score)";
    default: return "";
  }
}

function GenerationView({ gen, onSelect }: { gen: GenState; onSelect: (c: SubmittedCandidate) => void }) {
  if (gen.phase === "idle") return null;
  const checks = gen.events.filter((e): e is Extract<LoopEvent, { type: "check.result" }> => e.type === "check.result");
  const errors = gen.events.filter((e): e is Extract<LoopEvent, { type: "attempt.error" }> => e.type === "attempt.error");
  const c = gen.counters;
  return (
    <div className="gen" aria-live="polite">
      <p className="status">
        loop: <strong>{gen.phase}</strong>
        {c && gen.budget && <> · turn {c.turns}/{gen.budget.maxTurns} · checks {c.checks}/{gen.budget.maxChecks} · submissions {c.submissions}/{gen.budget.maxSubmissions} · output tokens {c.outputTokens.toLocaleString()}{c.unknownUsageTurns ? ` · ${c.unknownUsageTurns} turn(s) with unknown usage` : ""}</>}
        {gen.reconnects > 0 && <> · reconnected {gen.reconnects}×</>}
      </p>
      {gen.outcome && <p className="outcome"><strong>{outcomeText(gen.outcome)}</strong>{gen.stopDetail ? ` — ${gen.stopDetail}` : ""}</p>}
      {gen.error && <p className="error">{gen.error}</p>}
      {errors.map((e) => <p key={e.seq} className="error small">{e.code}: {e.message}{e.retryable ? " (one visible retry follows)" : ""}</p>)}
      {(gen.phase === "streaming" || gen.phase === "creating") && gen.preview && (
        <details open><summary>uncommitted preview (inert text; never executed)</summary><pre className="preview">{gen.preview.slice(-3000)}</pre></details>
      )}
      <ol className="attempts">
        {checks.map((ch, i) => (
          <li key={ch.seq}>
            <details open={i === checks.length - 1 && !ch.report.ok}>
              <summary>draft {i + 1} · check_candidate · {ch.report.ok ? "✓ clean" : `✕ ${ch.report.errors.length} error(s)`}{ch.report.sha256 ? ` · ${ch.report.sha256.slice(0, 12)}…` : ""}</summary>
              <DiagnosticList items={ch.report.errors} />
              {ch.report.suppressed > 0 && <p className="muted small">{ch.report.suppressed} cascade diagnostic(s) suppressed</p>}
            </details>
          </li>
        ))}
        {gen.submissions.map((s) => (
          <li key={`s${s.seq}`}>
            <details open>
              <summary>submission · {s.status}{s.sha256 ? ` · ${s.sha256.slice(0, 12)}…` : ""}</summary>
              <button className="link" onClick={() => onSelect(s)} disabled={!s.bytes}>inspect / run this candidate</button>
              <DiagnosticList items={s.check.errors} />
              {s.test && <DiagnosticList items={s.test.diagnostics} empty={s.test.passed ? "All tests passed." : ""} />}
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
