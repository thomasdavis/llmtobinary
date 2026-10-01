import { useCallback, useEffect, useMemo, useState } from "react";
import { parseHex } from "@llmtobinary/decode";
import { TASK_BY_ID } from "@llmtobinary/tasks/registry";
import { CHECKER_ID } from "@llmtobinary/check";
import { buildManifest, exportBundle, importBundle, openStore, memoryStore, type ArtifactRecord, type ArtifactStore, type Provenance } from "@llmtobinary/artifacts";
import type { CreateSessionRequest, GalleryEntry, RunResult } from "@llmtobinary/protocol";
import { getConfig, getGalleryEntry, type Config } from "./api.ts";
import { loadArtifact, type LoadedArtifact } from "./artifact.ts";
import { loadFixture } from "./fixtures.ts";
import { GenerationController, type GenState, type SubmittedCandidate } from "./generation.ts";
import { Inspector, type VerificationState } from "./Inspector.tsx";
import { verify } from "./verify-client.ts";
import { F_CHOICES, MachinePanel, parseEntryInputs } from "./Machine.tsx";
import { isBool, oneOf, usePersistentState } from "./settings.ts";
import { Intro, type IntroAction } from "./Intro.tsx";
import { GenerationModal } from "./GenerationModal.tsx";
import { BinaryView } from "./BinaryView.tsx";
import { AI_EXAMPLES, REFERENCE_EXAMPLES, loadExample, type AiExample } from "./examples.ts";
import { ProgramBar, ProgramCard, devices, duration, ago, outcomeStatus, programText, type ChosenProgram, type Pick, type RefExample } from "./ProgramPicker.tsx";
import { MachineClient, type MachineView } from "./machine-client.ts";
import { TaskPanel } from "./TaskPanel.tsx";
import type { CompareRow, EngineKind } from "./worker-protocol.ts";

const ALL_FEATURES = 15;
const PROGRAM_PARAM = "program";
const REF_BY_FILE = new Map(REFERENCE_EXAMPLES.map((r) => [r.file, r]));

/** Keep ?program=<id> in the address bar for a published program, so the page can be shared. */
function setProgramParam(id: string | null): void {
  try {
    const u = new URL(window.location.href);
    if (id) u.searchParams.set(PROGRAM_PARAM, id);
    else u.searchParams.delete(PROGRAM_PARAM);
    window.history.replaceState(null, "", u);
  } catch {
    /* no history API: the link just is not updated */
  }
}

const programLink = (id: string) => `${window.location.origin}/?${PROGRAM_PARAM}=${encodeURIComponent(id)}`;

function chosenFeatured(e: AiExample): ChosenProgram {
  const when = (e.counters as { startedAt?: number }).startedAt;
  return {
    key: `featured:${e.file}`,
    label: e.title,
    by: "ai",
    askedBy: "this project",
    prompt: e.prompt,
    facts: [
      ...(when ? [{ k: "Generated", v: ago(when) }] : []),
      { k: "Model", v: `${e.provenance.requestedModel ?? "?"}${e.reasoningEffort ? `, ${e.reasoningEffort} reasoning` : ""}` },
      { k: "Work", v: `${e.counters.turns} turns · ${e.counters.checks} checks` },
      { k: "Size", v: `${e.bytes.toLocaleString()} bytes` },
      { k: "Controls", v: e.controls },
    ],
  };
}

function chosenRef(r: RefExample): ChosenProgram {
  return { key: `ref:${r.file}`, label: r.title, by: "tools", askedBy: "this project", prompt: null, facts: [{ k: "What it does", v: r.about }, ...(r.controls ? [{ k: "Controls", v: r.controls }] : [])] };
}

function chosenPublic(g: GalleryEntry): ChosenProgram {
  const took = g.finishedAt ? duration(g.finishedAt - g.createdAt) : "";
  return {
    key: `public:${g.id}`,
    label: g.label || "Untitled program",
    by: "ai",
    askedBy: "a visitor",
    prompt: g.prompt,
    status: outcomeStatus(g.outcome),
    facts: [
      { k: "Asked", v: `${ago(g.createdAt)}${took ? ` · took ${took}` : ""}` },
      { k: "Model", v: `${g.model}${g.reasoningEffort ? `, ${g.reasoningEffort} reasoning` : ""}` },
      { k: "Work", v: `${g.turns} turns · ${g.checks} checks · ${g.submissions} submissions · ${g.outputTokens.toLocaleString()} tokens` },
      { k: "Bytes shown", v: programText(g) },
      ...(g.bytes ? [{ k: "Size", v: `${g.bytes.toLocaleString()} bytes · ${g.instructions.toLocaleString()} instructions` }] : []),
      { k: "Devices", v: devices(g.features).join(", ") || "none" },
    ],
    link: programLink(g.id),
    remix: g.taskId ? undefined : { description: g.prompt, params: parseSignature(g.signature).params, returns: parseSignature(g.signature).returns, features: g.features },
  };
}

/** "(u64, bool) -> u64" back into the entry signature (written by gallery.ts on the server). */
function parseSignature(sig: string): { params: ("u64" | "bool")[]; returns: "unit" | "u64" | "bool" } {
  const m = /^\((.*)\) -> (unit|u64|bool)$/.exec(sig);
  const params = (m?.[1] ?? "").split(",").map((x) => x.trim()).filter((x): x is "u64" | "bool" => x === "u64" || x === "bool");
  return { params, returns: (m?.[2] as "unit" | "u64" | "bool" | undefined) ?? "u64" };
}

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
  const [F, setF] = usePersistentState("fastSlots", 16, oneOf(...F_CHOICES));
  const [engine, setEngine] = usePersistentState<EngineKind>("engine", "exact", oneOf("exact", "fast"));
  const [tickRate, setTickRate] = usePersistentState("tickRate", 30, oneOf(20, 30, 60));
  const [expert, setExpert] = usePersistentState("expert", false, isBool);
  const [introSeen, setIntroSeen] = usePersistentState("introSeen", false, isBool);
  const [introOpen, setIntroOpen] = useState(!introSeen);
  const [promptFocus, setPromptFocus] = useState(0);
  const [genOpen, setGenOpen] = useState(false);
  /** The program picked in the program bar, and the bytes it loaded (the card hides once others load). */
  const [chosen, setChosen] = useState<{ program: ChosenProgram; sha: string | null } | null>(null);
  const [galleryRefresh, setGalleryRefresh] = useState(0);
  const [remix, setRemix] = useState<{ n: number; value: NonNullable<ChosenProgram["remix"]> } | null>(null);
  const closeIntro = () => {
    setIntroOpen(false);
    setIntroSeen(true);
  };
  const [inputTexts, setInputTexts] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ rows: CompareRow[]; semanticAgreement: boolean; missingBackingActivity: number[]; resourceLimited: number[] } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [tab, setTab] = usePersistentState<"program" | "executable" | "machine">("mobileTab", "program", oneOf("program", "executable", "machine"));
  useEffect(() => {
    machine.setTickRate(tickRate);
  }, [machine, tickRate]);
  const [notice, setNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationState | null>(null);
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

  // Simple view: examples load and run straight away.
  const [autoRun, setAutoRun] = useState<string | null>(null);
  const onExample = async (e: { kind: "ai"; example: AiExample } | { kind: "ref"; file: string; task: string }) => {
    try {
      let a: LoadedArtifact;
      if (e.kind === "ai") {
        const bytes = await loadExample(e.example.file);
        a = await loadArtifact({ bytes, annotations: e.example.annotations, name: e.example.file, taskId: null, provenance: e.example.provenance, allowedFeatures: allowed });
      } else {
        const bytes = await loadFixture(e.file);
        a = await loadArtifact({ bytes, name: e.file, taskId: TASK_BY_ID.has(e.task) ? e.task : null, provenance: { kind: "bundled-fixture", file: e.file, origin: "fixtures/manifest.json", modelOutput: false }, allowedFeatures: allowed });
      }
      setAutoRun(a.record.sha256);
      setChosen({ program: e.kind === "ai" ? chosenFeatured(e.example) : chosenRef(REF_BY_FILE.get(e.file)!), sha: a.record.sha256 });
      setProgramParam(null);
      await select(a);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const openPublic = async (id: string) => {
    try {
      const g = await getGalleryEntry(id);
      setProgramParam(g.id);
      if (!g.program || !g.hex || !g.sha256 || !g.attemptId || g.candidateSeq === null) {
        // Nothing to run (the AI never wrote a complete program): show what was asked.
        machine.hardReset();
        setArtifact(null);
        setChosen({ program: chosenPublic(g), sha: null });
        return;
      }
      const h = parseHex(g.hex);
      if (!h.ok) throw new Error("its bytes could not be read");
      const provenance: Provenance = { kind: "model-generated", sessionId: g.sessionId, attemptId: g.attemptId, candidateSeq: g.candidateSeq, requestedModel: g.model, returnedModels: g.returnedModels, mode: g.mode, promptVersion: g.promptVersion, modelOutput: true };
      const a = await loadArtifact({ bytes: h.bytes, annotations: g.annotations, name: `generation-${g.sha256.slice(0, 8)}.anma`, taskId: g.taskId && TASK_BY_ID.has(g.taskId) ? g.taskId : null, provenance, allowedFeatures: g.features & allowed });
      if (a.module) setAutoRun(a.record.sha256);
      setChosen({ program: chosenPublic(g), sha: a.record.sha256 });
      await select(a);
    } catch (err) {
      setNotice(`That generation could not be opened: ${(err as Error).message}`);
    }
  };

  const onPick = async (p: Pick) => {
    if (p.kind === "featured") await onExample({ kind: "ai", example: p.example });
    else if (p.kind === "ref") await onExample({ kind: "ref", file: p.ref.file, task: p.ref.task });
    else await openPublic(p.summary.id);
  };

  // A shared link (?program=<id>) opens that generation.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get(PROGRAM_PARAM);
    if (id) void openPublic(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    gen.onPassed = (c) => {
      void onSubmission(c);
      // The visitor's own program: show what they asked, like any other program.
      const req = gen.state.request;
      if (!req || !c.sha256) return;
      const task = req.task.taskId ? TASK_BY_ID.get(req.task.taskId) : null;
      const summary = c.annotations && typeof c.annotations === "object" ? (c.annotations as { summary?: unknown }).summary : null;
      const s = gen.state;
      setProgramParam(null);
      setChosen({
        sha: c.sha256,
        program: {
          key: `mine:${c.sha256}`,
          label: typeof summary === "string" && summary.trim() ? (summary.trim().length > 90 ? `${summary.trim().slice(0, 89)}…` : summary.trim()) : (task?.title ?? "Your program"),
          by: "ai",
          askedBy: "you",
          prompt: task ? task.prompt : req.task.description,
          status: { text: "✓ works", tone: "ok" },
          facts: [
            { k: "Generated", v: `just now${s.startedAt ? ` · took ${duration(Date.now() - s.startedAt)}` : ""}` },
            { k: "Model", v: config?.profiles[0]?.model ?? "?" },
            ...(s.counters ? [{ k: "Work", v: `${s.counters.turns} turns · ${s.counters.checks} checks` }] : []),
            ...(c.bytes ? [{ k: "Size", v: `${c.bytes.length.toLocaleString()} bytes` }] : []),
            { k: "Listed", v: "publicly, in the program list" },
          ],
        },
      });
    };
  }, [gen, onSubmission, config]);

  // The visitor's own generation appears in the list when it starts, and updates when it stops.
  useEffect(() => {
    if (genState.phase === "stopped" || (genState.phase === "streaming" && genState.sessionId)) {
      const t = setTimeout(() => setGalleryRefresh((n) => n + 1), 1500);
      return () => clearTimeout(t);
    }
  }, [genState.phase, genState.sessionId]);

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

  const loadRun = (replay = false, f = F, eng: EngineKind = engine) => {
    if (!artifact?.module) return;
    const p = parseEntryInputs(artifact, inputTexts);
    if (!p.inputs) return;
    const task = artifact.record.taskId ? TASK_BY_ID.get(artifact.record.taskId) : null;
    const interactive = (artifact.module.features & 8) !== 0;
    const replayTicks = replay ? [...view.ticks] : task?.visible[0]?.ticks && !interactive ? task.visible[0].ticks : undefined;
    machine.load(artifact.record.bytes, p.inputs, { fastSlots: f, policy: "fifo-v1", trace: true }, task?.features ?? allowed, { interactive, engine: eng, ...(replayTicks ? { replayTicks } : {}) });
    machine.run();
    setLastRun({ inputs: p.inputs, F: f });
    setTab("machine");
  };

  useEffect(() => {
    if (!autoRun || artifact?.record.sha256 !== autoRun || !artifact.module) return;
    setAutoRun(null);
    loadRun();
    // Games take keys at once: focus the screen and bring the chip into view.
    setTimeout(() => {
      const fb = document.querySelector<HTMLCanvasElement>("section.livechip canvas.fb");
      document.querySelector("section.livechip")?.scrollIntoView({ block: "start", behavior: "smooth" });
      if (fb && fb.tabIndex >= 0) fb.focus({ preventScroll: true });
    }, 150);
  }, [artifact, autoRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeF = (f: number) => {
    setF(f);
    if (lastRun) loadRun(false, f); // same immutable bytes, fresh machine
  };

  const changeEngine = (e: EngineKind) => {
    setEngine(e);
    if (lastRun) loadRun(false, F, e); // same bytes, other engine, fresh run
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
      verification: verification?.sha === artifact.record.sha256 && verification.status === "done" ? verification.report : null,
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

  // "Share for debugging": what only this browser knows, next to the server's session archive.
  const onShareDebug = async (): Promise<{ debugId: string; environment: string }> => {
    const r = view.result;
    const s = view.snapshot;
    const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b.length > 65_536 ? b.subarray(b.length - 65_536) : b) : "");
    return gen.share({
      app: { build: config?.buildCommit ?? null, environment: config?.environment ?? null, specSha256: config?.specSha256 ?? null, promptVersion: config?.promptVersion ?? null, url: location.href, userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight] },
      artifact: artifact ? { name: artifact.record.name, sha256: artifact.record.sha256, status: artifact.record.status, provenance: artifact.record.provenance, byteLength: artifact.record.byteLength, check: artifact.check, test: artifact.test } : null,
      machine: {
        status: view.status,
        error: view.error,
        F,
        inputs: inputTexts,
        lastRun,
        ticksRecorded: view.ticks.length,
        ticks: view.ticks.slice(-10_000),
        position: s?.position ?? null,
        counters: s?.counters ?? null,
        backing: s ? { used: s.backing.used, capacity: s.backing.capacity, highWater: s.backing.highWater } : null,
        terminal: view.terminal.length > 65_536 ? view.terminal.slice(-65_536) : view.terminal,
        result: r ? { status: r.status, returnValue: r.returnValue, trap: r.trap, counters: r.counters, effectCount: r.effectCount, effectsHash: r.effectsHash, framebufferHash: r.framebufferHash, framesPresented: r.framesPresented, terminal: text(r.terminal) } : null,
        framebufferPng: view.frame ? await frameToPng(view.frame) : null,
      },
    });
  };

  const running = view.status === "running" || view.status === "waiting-input";
  // The card follows the program it describes: it hides once other bytes are loaded.
  const chosenShown = !!chosen && (chosen.sha === null ? !artifact : artifact?.record.sha256 === chosen.sha);
  const onIntroAction = (a: IntroAction) => {
    closeIntro();
    if (a === "watch") {
      // The first impression is a game: run it on the fast engine so it plays smoothly.
      setEngine("fast");
      void onExample({ kind: "ai", example: AI_EXAMPLES[0]! });
    }
    if (a === "ask") setPromptFocus((n) => n + 1);
  };
  return (
    <>
    <nav className="topbar" aria-label="Site">
      <div className="topbar-inner">
        <h1 className="topbar-brand">llmtobinary</h1>
        <div className="topbar-actions">
          <button className="topbar-help" onClick={() => setIntroOpen(true)}>What is this?</button>
          <div className="segmented view-toggle" role="radiogroup" aria-label="View">
            <button role="radio" aria-checked={!expert} className={!expert ? "on" : ""} onClick={() => setExpert(false)} title="The guided view: choose a program, read its binary in plain English, run it">Simple</button>
            <button role="radio" aria-checked={expert} className={expert ? "on" : ""} onClick={() => setExpert(true)} title="The full instrument: hex inspector, diagnostics, counters, trace, curated tasks, export">Expert</button>
          </div>
        </div>
      </div>
    </nav>
    <ProgramBar chosen={chosenShown ? chosen.program : null} onPick={onPick} onAsk={() => { setTab("program"); setPromptFocus((n) => n + 1); }} refresh={galleryRefresh} />
    <div className={`app${expert ? " is-expert" : " is-simple"}`}>
      <Intro open={introOpen} onClose={closeIntro} onAction={onIntroAction} canGenerate={!!config?.liveGeneration} />
      <GenerationModal
        gen={genState}
        open={genOpen}
        onClose={() => setGenOpen(false)}
        onCancel={() => void gen.cancel()}
        onRun={(sha) => {
          setGenOpen(false);
          setAutoRun(sha);
        }}
        onShareDebug={onShareDebug}
      />
      <header className="site-head">
        <div className="site-title">
          <p className="pitch">An AI writes machine code directly, byte by byte, for ANMA-1: a processor designed so that AI can program it. No source code, no compiler.</p>
          <p className="tagline">OpenAI generation · TypeScript virtual-machine execution in your browser.</p>
        </div>
        {expert && (
          <p className="muted small site-meta">
            {config ? <>spec {config.specId} ({config.specSha256.slice(0, 12)}) · build {config.buildCommit} · {config.environment} · {config.liveGeneration ? "live generation available" : "fixture mode"}</> : configError ? `offline or API unavailable (${configError}) — fixtures and saved artifacts still run` : "loading configuration…"}
          </p>
        )}
      </header>
      {chosenShown && <ProgramCard chosen={chosen.program} onRemix={(r) => { setTab("program"); setRemix((x) => ({ n: (x?.n ?? 0) + 1, value: r })); setPromptFocus((n) => n + 1); }} />}
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
          <TaskPanel config={config} configError={configError} gen={genState} history={history} onFixture={onFixture} onGenerate={(req: CreateSessionRequest) => {
              setGenOpen(true);
              void gen.start(req);
            }} onCancel={() => void gen.cancel()} onSelectSubmission={(c) => void onSubmission(c)} onSelectHistory={(h) => void loadArtifact({ bytes: h.bytes, annotations: h.annotations, name: h.name, taskId: h.taskId, provenance: h.provenance, responseText: h.responseText, allowedFeatures: allowed }).then((a) => select(a))} onImport={(f) => void onImport(f)} onExport={(w) => void onExport(w)} onDownload={onDownload} onClearHistory={() => void onClearHistory()} hasArtifact={!!artifact} onShareDebug={onShareDebug} expert={expert} promptFocus={promptFocus} remix={remix} />
        </div>
        <div className="col col-executable">
          {!expert ? <BinaryView artifact={artifact} onExpert={() => setExpert(true)} /> : <Inspector
            artifact={artifact}
            selected={selected}
            onSelect={setSelected}
            verification={verification}
            onVerify={() => {
              if (!artifact) return;
              const sha = artifact.record.sha256;
              setVerification({ sha, status: "running" });
              void verify(artifact.record.bytes, artifact.record.taskId, artifact.record.annotations).then((r) => setVerification(r.ok ? { sha, status: "done", report: r.report } : { sha, status: "unavailable", reason: r.unavailable }));
            }}
          />}
        </div>
        <div className="col col-machine">
          <MachinePanel expert={expert} artifact={artifact} view={view} machine={machine} F={F} setF={changeF} engine={engine} setEngine={changeEngine} tickRate={tickRate} setTickRate={setTickRate} inputTexts={inputTexts} setInputTexts={setInputTexts} onLoadRun={(replay) => loadRun(!!replay)} compare={compare} onCompare={() => void onCompare()} comparing={comparing} allowedFeatures={allowed} />
        </div>
      </main>
      <footer className="muted small">
        A truthful claim: the model generates bytes; your browser runs them, either through this TypeScript virtual machine or translated binary-to-binary into WebAssembly (identical results); the machine — not the model — manages storage. Not a native chip, not compiler-free, not a universal register limit.
      </footer>
    </div>
    </>
  );
}

/** The presented 256×144 frame as a PNG data URL (for the debug bundle). */
async function frameToPng(frame: Uint8ClampedArray): Promise<string | null> {
  try {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 144;
    const buf = new Uint8ClampedArray(frame.length);
    buf.set(frame);
    c.getContext("2d")!.putImageData(new ImageData(buf, 256, 144), 0, 0);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}
