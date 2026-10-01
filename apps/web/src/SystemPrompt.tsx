// "System prompt": exactly what every generation sends the model — the system instructions, the
// first message built from the visitor's prompt (shown with a placeholder) and the two tools —
// fetched from the Worker so it is the deployed text, not a copy.

import { useEffect, useRef, useState } from "react";
import { KNOWN_FEATURES } from "@llmtobinary/spec";
import { openTaskPromptText } from "@llmtobinary/tasks/registry";
import { getSystemPrompt, type SystemPrompt } from "./api.ts";

const PLACEHOLDER = "⟨YOUR PROMPT⟩";
const DRAFT_KEY = "llmtobinary.customPrompt.v1";

/** The entry signature and devices from the visitor's saved prompt settings (defaults otherwise). */
function savedSettings(): { params: ("u64" | "bool")[]; returns: "unit" | "u64" | "bool"; features: number } {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as { params?: unknown; returns?: unknown; features?: unknown; devicesV?: number } | null;
    const params = Array.isArray(d?.params) ? (d!.params as unknown[]).filter((p): p is "u64" | "bool" => p === "u64" || p === "bool") : ["u64" as const];
    const returns = d?.returns === "unit" || d?.returns === "bool" || d?.returns === "u64" ? d.returns : "u64";
    const features = d?.devicesV === 2 && typeof d.features === "number" ? d.features : KNOWN_FEATURES;
    return { params, returns, features };
  } catch {
    return { params: ["u64"], returns: "u64", features: KNOWN_FEATURES };
  }
}

export function SystemPromptModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<SystemPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState(savedSettings);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setSettings(savedSettings());
      setCopied(false);
      d.showModal();
      if (!data) getSystemPrompt().then(setData, (e) => setError((e as Error).message));
    } else if (!open && d.open) d.close();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const message = openTaskPromptText(PLACEHOLDER, settings.params, settings.returns, settings.features);
  const [before, after] = message.split(PLACEHOLDER) as [string, string];
  const tools = data ? data.tools.map((t) => `${t.name}: ${t.description}\nparameters: ${JSON.stringify(t.parameters, null, 2)}`).join("\n\n") : "";
  const copyAll = () => {
    if (!data) return;
    const all = `=== SYSTEM INSTRUCTIONS ===\n${data.instructions}\n\n=== FIRST MESSAGE ===\n${message}\n\n=== TOOLS ===\n${tools}\n`;
    void navigator.clipboard?.writeText(all).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <dialog ref={ref} className="intro sysprompt" aria-labelledby="sysprompt-title" onClose={onClose} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="intro-inner">
        <header className="intro-head">
          <span className="intro-kicker">{data ? `prompt version ${data.promptVersion}` : "loading…"}</span>
          <div className="row">
            <button onClick={copyAll} disabled={!data}>{copied ? "Copied" : "Copy all"}</button>
            <button className="intro-close" onClick={onClose} aria-label="Close the system prompt">✕</button>
          </div>
        </header>
        <h2 id="sysprompt-title">System prompt</h2>
        <p className="sysprompt-lead">Every generation sends the AI exactly this. As the loop runs, the only other things it sees are the checker's reports on its drafts and your browser's test results.</p>
        {open && <div className="sysprompt-body">
          {error && <p className="error">Couldn't load the system prompt: {error}</p>}
          <section>
            <h3>1. Instructions <span className="muted">(the system message)</span></h3>
            <pre className="sysprompt-text">{data ? data.instructions : "Loading…"}</pre>
          </section>
          <section>
            <h3>2. First message <span className="muted">(built from your prompt)</span></h3>
            <pre className="sysprompt-text">
              {before}
              <mark className="sysprompt-slot">{PLACEHOLDER}</mark>
              {after}
            </pre>
            <p className="muted small">The entry signature and devices lines follow your program settings. A curated task in the expert view sends that task's own text instead.</p>
          </section>
          <section>
            <h3>3. Tools the AI can call</h3>
            <pre className="sysprompt-text">{data ? tools : "Loading…"}</pre>
          </section>
        </div>}
      </div>
    </dialog>
  );
}
