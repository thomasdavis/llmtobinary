import { useCallback, useEffect, useMemo, useState } from "react";
import { parseHex } from "@llmtobinary/decode";
import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { CHECKER_ID } from "@llmtobinary/check";
import { buildManifest, exportBundle, importBundle, openStore, memoryStore, type ArtifactRecord, type ArtifactStore, type Provenance } from "@llmtobinary/artifacts";
import type { CreateSessionRequest, RunResult } from "@llmtobinary/protocol";
import { getConfig, type Config } from "./api.ts";
import { loadArtifact, type LoadedArtifact } from "./artifact.ts";
import { loadFixture } from "./fixtures.ts";
import { GenerationController, type GenState, type SubmittedCandidate } from "./generation.ts";
import { Inspector } from "./Inspector.tsx";
import { MachinePanel, parseEntryInputs } from "./Machine.tsx";
import { MachineClient, type MachineView } from "./machine-client.ts";
import { TaskPanel } from "./TaskPanel.tsx";
import type { CompareRow } from "./worker-protocol.ts";

const ALL_FEATURES = 15;

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const machine = useMemo(() => new MachineClient(), []);
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const allowed = config?.allowedFeatures ?? ALL_FEATURES;
  const gen = useMemo(() => new GenerationController(machine, () => allowed), [machine, allowed]);
  const [genState, setGenState] = useState<GenState>(gen.state);
  const [view, setView] = useState<MachineView>(machine.view);
  const [store, setStore] = useState<ArtifactStore>(() => memoryStore());
  const [history, setHistory] = useState<ArtifactRecord[]>([]);
  const [artifact, setArtifact] = useState<LoadedArtifact | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [F, setF] = useState(16);
  const [inputTexts, setInputTexts] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ rows: CompareRow[]; semanticAgreement: boolean; missingBackingActivity: number[]; resourceLimited: number[] } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [tab, setTab] = useState<"program" | "executable" | "machine">("program");
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ inputs: ReturnType<typeof parseEntryInputs>["inputs"]; F: number } | null>(null);

  useEffect(() => machine.subscribe(setView), [machine]);
  useEffect(() => gen.subscribe(setGenState), [gen]);
  useEffect(() => {
    getConfig().then(setConfig, (e) => setConfigError((e as Error).message));
    openStore().then((s) => {
      setStore(s);
      s.listArtifacts().then(setHistory, () => undefined);
    });
  }, []);
  const refreshHistory = useCallback(() => store.listArtifacts().then(setHistory, () => undefined), [store]);

  const select = useCallback(
    async (a: LoadedArtifact, opts: { test?: boolean } = {}) => {
      machine.hardReset();
      setArtifact(a);
      setSelected(null);
      setCompare(null);
      setLastRun(null);
      const task = a.record.taskId ? TASK_BY_ID.get(a.record.taskId) : null;
      const entry = a.module?.functions[a.module.entry];
      setInputTexts(entry ? entry.params.map((_, i) => task?.visible[0]?.inputs[i] ?? (entry.params[i] === 2 ? "false" : "0")) : []);
      setTab("executable");
      await store.putArtifact(a.record).catch(() => undefined);
      refreshHistory();
      if (opts.test !== false && a.module) {
        try {
          const claims = a.check.annotations.claimsChecked ? { checked: a.check.annotations.claimsChecked, matched: a.check.annotations.claimsMatched } : null;
          const t = await machine.test(a.record.bytes, a.record.taskId, a.record.annotations, claims, task?.features ?? allowed);
          const status: ArtifactRecord["status"] = t.report.passed ? (a.record.taskId ? "task-passed" : "executed-unverified") : t.report.diagnostics.some((d) => d.rule === "ANMA-K-009") ? "resource-limited" : "task-failed";
          const next = { ...a, test: t.report, witness: t.witness, record: { ...a.record, status } };
          setArtifact((cur) => (cur?.record.sha256 === a.record.sha256 ? next : cur));
          await store.putArtifact(next.record).catch(() => undefined);
          refreshHistory();
        } catch (e) {
          setNotice(`tests could not run: ${(e as Error).message}`);
        }
      }
    },
    [machine, store, refreshHistory, allowed],
  );

  const onFixture = async (file: string, task: string) => {
    try {
      const bytes = await loadFixture(file);
      const provenance: Provenance = { kind: "bundled-fixture", file, origin: "fixtures/manifest.json", modelOutput: false };
      await select(await loadArtifact({ bytes, name: file, taskId: TASK_BY_ID.has(task) ? task : null, provenance, allowedFeatures: allowed }));
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const onSubmission = useCallback(
    async (c: SubmittedCandidate) => {
      if (!c.bytes) return;
      const req = gen.state.request;
      const provenance: Provenance = { kind: "model-generated", sessionId: gen.state.sessionId ?? "", attemptId: c.attemptId, candidateSeq: c.seq, requestedModel: config?.profiles[0]?.model ?? null, returnedModels: [], mode: req?.mode ?? "tools", promptVersion: config?.promptVersion ?? null, modelOutput: true };
      const a = await loadArtifact({ bytes: c.bytes, annotations: c.annotations, name: `generated-${(c.sha256 ?? "").slice(0, 8)}.anma`, taskId: req?.task.taskId ?? null, provenance, responseText: c.envelopeText, allowedFeatures: req?.task.allowedFeatures ?? allowed });
      await select(a);
    },
    [gen, config, select, allowed],
  );
  useEffect(() => {
    gen.onPassed = (c) => void onSubmission(c);
  }, [gen, onSubmission]);

  // Record finished generation sessions locally (the transcript is exported only on opt-in).
  useEffect(() => {
    if (genState.phase === "stopped" && genState.sessionId) {
      void store.putSession({ sessionId: genState.sessionId, at: Date.now(), taskId: genState.request?.task.taskId ?? null, mode: genState.request?.mode ?? "tools", outcome: genState.outcome, events: genState.events.filter((e) => e.type !== "model.tool_args.delta" && e.type !== "model.text.delta"), requestedModel: config?.profiles[0]?.model ?? null, returnedModels: [] }).catch(() => undefined);
    }
  }, [genState.phase, genState.sessionId, genState.outcome, genState.events, genState.request, store, config]);

  // Record finished runs.
  useEffect(() => {
    const r = view.result;
    if (!r || !artifact || !lastRun?.inputs) return;
    let s = "";
    for (let i = 0; i < r.terminal.length; i += 0x8000) s += String.fromCharCode(...r.terminal.subarray(i, i + 0x8000));
    void store.putRun({ runId: crypto.randomUUID(), sha256: artifact.record.sha256, at: Date.now(), config: r.config ?? { fastSlots: lastRun.F, policy: "fifo-v1", trace: true }, inputs: lastRun.inputs, ticks: view.ticks, result: { status: r.status, returnValue: r.returnValue, terminalBase64: btoa(s), effectsHash: r.effectsHash, effectCount: r.effectCount, framebufferHash: r.framebufferHash, trap: r.trap, counters: r.counters, traceTruncated: r.traceTruncated } }).catch(() => undefined);
  }, [view.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRun = (replay = false, f = F) => {
    if (!artifact?.module) return;
    const p = parseEntryInputs(artifact, inputTexts);
    if (!p.inputs) return;
    const task = artifact.record.taskId ? TASK_BY_ID.get(artifact.record.taskId) : null;
    const interactive = (artifact.module.features & 8) !== 0;
    const replayTicks = replay ? [...view.ticks] : task?.visible[0]?.ticks && !interactive ? task.visible[0].ticks : undefined;
    machine.load(artifact.record.bytes, p.inputs, { fastSlots: f, policy: "fifo-v1", trace: true }, task?.features ?? allowed, { interactive, ...(replayTicks ? { replayTicks } : {}) });
    machine.run();
    setLastRun({ inputs: p.inputs, F: f });
    setTab("machine");
  };

  const changeF = (f: number) => {
    setF(f);
    if (lastRun) loadRun(false, f); // same immutable bytes, fresh machine
  };

  const onCompare = async () => {
    if (!artifact?.module) return;
    const p = parseEntryInputs(artifact, inputTexts);
    if (!p.inputs) return;
    setComparing(true);
    try {
      const task = artifact.record.taskId ? TASK_BY_ID.get(artifact.record.taskId) : null;
      const ticks = view.ticks.length ? view.ticks : (task?.visible[0]?.ticks ?? []);
      setCompare(await machine.compare(artifact.record.bytes, p.inputs, [1, 4, 8, 16, 32, 64], ticks, task?.features ?? allowed));
    } catch (e) {
      setNotice(`comparison failed: ${(e as Error).message}`);
    } finally {
      setComparing(false);
    }
  };

  const onImport = async (file: File) => {
    try {
      let bytes: Uint8Array;
      let annotations: unknown = null;
      const warnings: string[] = [];
      if (file.name.endsWith(".json")) {
        const r = await importBundle(await file.text(), file.name);
        bytes = r.bytes;
        annotations = r.annotations;
        warnings.push(...r.warnings);
      } else if (file.name.endsWith(".anma")) {
        if (file.size > 1024 * 1024) throw new Error("imported executables are limited to 1 MiB");
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        const h = parseHex(await file.text(), 1024 * 1024);
        if (!h.ok) throw new Error(`${h.diagnostics[0]!.rule}: ${h.diagnostics[0]!.message}`);
        bytes = h.bytes;
      }
      const a = await loadArtifact({ bytes, annotations, name: file.name, taskId: null, provenance: { kind: "imported", fileName: file.name, clientClaimsUnverified: true, modelOutput: false }, allowedFeatures: allowed });
      await select(a, { test: false }); // imported executables start stopped
      setNotice(["Imported executable loaded (stopped). Press Run to execute it.", ...warnings].join(" "));
    } catch (e) {
      setNotice(`import failed: ${(e as Error).message}`);
    }
  };

  const onExport = async (withPrompts: boolean) => {
    if (!artifact) return;
    const r: RunResult | null = view.result;
    const runs = r && lastRun?.inputs ? [{ config: r.config ?? { fastSlots: lastRun.F, policy: "fifo-v1" as const, trace: true }, inputs: lastRun.inputs, ticks: view.ticks, result: r }] : [];
    const prov = artifact.record.provenance;
    const manifest = await buildManifest({
      specSha256: config?.specSha256 ?? "unknown",
      buildCommit: config?.buildCommit ?? "unknown",
      deploymentId: config?.deploymentId ?? null,
      artifact: artifact.record,
      validationOk: artifact.check.ok,
      checker: CHECKER_ID,
      testReport: artifact.test,
      witness: artifact.witness,
      runs,
      ...(prov.kind === "model-generated"
        ? { generation: { sessionId: prov.sessionId, attemptIds: [prov.attemptId], requestedModel: prov.requestedModel, mode: prov.mode, promptVersion: prov.promptVersion, outcome: genState.sessionId === prov.sessionId ? genState.outcome : null, usage: genState.counters ? { outputTokens: genState.counters.outputTokens, inputTokens: genState.counters.inputTokens, unknownUsageTurns: genState.counters.unknownUsageTurns } : null, budgetPolicy: config?.pricePolicy ?? null, loopTranscriptIncluded: withPrompts, reasoningCarried: null, providerResponseIds: genState.events.filter((e) => e.type === "attempt.completed").flatMap((e) => (e as { responseIds: string[] }).responseIds) } }
        : {}),
    });
    const task = artifact.record.taskId ? TASK_BY_ID.get(artifact.record.taskId) ?? null : null;
    const history = withPrompts ? genState.events.filter((e) => e.type !== "model.tool_args.delta" && e.type !== "model.text.delta") : undefined;
    download(`${artifact.record.name.replace(/\.anma$/, "")}.llmtobinary.json`, exportBundle(manifest, artifact.record, task, runs[0] ? { inputs: runs[0].inputs, ticks: runs[0].ticks } : null, history), "application/json");
  };

  const onDownload = (kind: "anma" | "hex") => {
    if (!artifact) return;
    const b = artifact.record.bytes;
    if (kind === "anma") download(artifact.record.name.endsWith(".anma") ? artifact.record.name : `${artifact.record.name}.anma`, b.slice(), "application/octet-stream");
    else download(`${artifact.record.name.replace(/\.anma$/, "")}.hex`, Array.from({ length: Math.ceil(b.length / 16) }, (_, i) => Array.from(b.subarray(i * 16, i * 16 + 16), (x) => x.toString(16).padStart(2, "0")).join(" ")).join("\n") + "\n", "text/plain");
  };

  const onClearHistory = async () => {
    await store.clear().catch(() => undefined);
    setHistory([]);
    setNotice("Local history cleared.");
  };

  const running = view.status === "running" || view.status === "waiting-input";
  return (
    <div className="app">
      <header>
        <h1>llmtobinary</h1>
        <p className="tagline">OpenAI generation · TypeScript virtual-machine execution in your browser.</p>
        <p className="muted small">
          {config ? <>spec {config.specId} ({config.specSha256.slice(0, 12)}) · build {config.buildCommit} · {config.environment} · {config.liveGeneration ? "live generation available" : "fixture mode"}</> : configError ? `offline or API unavailable (${configError}) — fixtures and saved artifacts still run` : "loading configuration…"}
        </p>
      </header>
      {notice && <p className="notice" role="status">{notice} <button className="link" onClick={() => setNotice(null)}>dismiss</button></p>}
      <nav className="tabs mobile" role="tablist" aria-label="Panels">
        {(["program", "executable", "machine"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <div className="execbar" aria-live="polite">
        <span>machine: <strong>{view.status}</strong></span>
        <button onClick={() => machine.stop()} disabled={!running}>■ Stop</button>
      </div>
      <main className={`layout show-${tab}`}>
        <div className="col col-program">
          <TaskPanel config={config} configError={configError} gen={genState} history={history} onFixture={onFixture} onGenerate={(req: CreateSessionRequest) => void gen.start(req)} onCancel={() => void gen.cancel()} onSelectSubmission={(c) => void onSubmission(c)} onSelectHistory={(h) => void loadArtifact({ bytes: h.bytes, annotations: h.annotations, name: h.name, taskId: h.taskId, provenance: h.provenance, responseText: h.responseText, allowedFeatures: allowed }).then((a) => select(a))} onImport={(f) => void onImport(f)} onExport={(w) => void onExport(w)} onDownload={onDownload} onClearHistory={() => void onClearHistory()} hasArtifact={!!artifact} />
        </div>
        <div className="col col-executable">
          <Inspector artifact={artifact} selected={selected} onSelect={setSelected} />
        </div>
        <div className="col col-machine">
          <MachinePanel artifact={artifact} view={view} machine={machine} F={F} setF={changeF} inputTexts={inputTexts} setInputTexts={setInputTexts} onLoadRun={(replay) => loadRun(!!replay)} compare={compare} onCompare={() => void onCompare()} comparing={comparing} allowedFeatures={allowed} />
        </div>
      </main>
      <footer className="muted small">
        A truthful claim: the model generates bytes; this TypeScript virtual machine executes them in your browser; the machine — not the model — manages storage. Not a native chip, not compiler-free, not a universal register limit.
      </footer>
    </div>
  );
}
