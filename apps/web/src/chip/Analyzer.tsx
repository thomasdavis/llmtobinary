import { useEffect, useRef, useState } from "react";
import type { ChipUnit, MicroEvent } from "@llmtobinary/protocol";
import { describe, isSpillTraffic, unitsOf } from "./units.ts";

export interface AnalyzerTrack {
  label: string;
  isa: "ANMA-1" | "ANMR-1";
  events: readonly MicroEvent[];
  t: number;
}

const LANES: Record<"ANMA-1" | "ANMR-1", { id: string; label: string; units: ChipUnit[] }[]> = {
  "ANMA-1": [
    { id: "fetch", label: "fetch / decode", units: ["imem", "fetch", "decode"] },
    { id: "directory", label: "directory", units: ["directory"] },
    { id: "slots", label: "fast slots", units: ["slots"] },
    { id: "latches", label: "latches", units: ["latches"] },
    { id: "alu", label: "ALU", units: ["alu"] },
    { id: "backing", label: "backing SRAM", units: ["backing"] },
    { id: "staging", label: "staging · I/O", units: ["staging", "io", "heap"] },
    { id: "stack", label: "call stack", units: ["stack"] },
  ],
  "ANMR-1": [
    { id: "fetch", label: "fetch / decode", units: ["imem", "fetch", "decode"] },
    { id: "regfile", label: "register file", units: ["regfile"] },
    { id: "alu", label: "ALU", units: ["alu"] },
    { id: "spill", label: "spill memory", units: ["spill"] },
  ],
};

const LANE_H = 18;
const LABEL_W = 132;
const HEAD_H = 22;

function css(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#999";
}

export function Analyzer({ tracks, windowTicks }: { tracks: AnalyzerTrack[]; windowTicks: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Mirrors the draw loop: 4px top inset, then per track a header, its lanes, and an 8px gap.
  const height = tracks.reduce((h, tr) => h + HEAD_H + LANES[tr.isa].length * LANE_H + 8, 4);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.floor(width * dpr);
    c.height = Math.floor(height * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const colors = { ink: css(c, "--chip-ink-2"), dim: css(c, "--chip-ink-3"), rule: css(c, "--chip-rule"), signal: css(c, "--chip-signal"), spill: css(c, "--chip-spill"), cursor: css(c, "--chip-ink") };
    const plotW = width - LABEL_W - 12;
    let y0 = 4;
    for (const tr of tracks) {
      const lanes = LANES[tr.isa];
      const t1 = Math.max(tr.t, windowTicks);
      const t0 = t1 - windowTicks;
      const x = (tick: number) => LABEL_W + ((tick - t0) / windowTicks) * plotW;
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillStyle = colors.ink;
      ctx.fillText(`${tr.label}  ·  t = ${Math.floor(tr.t).toLocaleString()} modeled ticks`, 8, y0 + 14);
      const top = y0 + HEAD_H;
      lanes.forEach((ln, i) => {
        const ly = top + i * LANE_H;
        ctx.fillStyle = colors.dim;
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(ln.label, 8, ly + 13);
        ctx.strokeStyle = colors.rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LABEL_W, ly + LANE_H - 0.5);
        ctx.lineTo(width - 12, ly + LANE_H - 0.5);
        ctx.stroke();
      });
      // tick grid every 10 ticks
      ctx.strokeStyle = colors.rule;
      for (let k = Math.ceil(t0 / 10) * 10; k <= t1; k += 10) {
        const gx = Math.round(x(k)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, top);
        ctx.lineTo(gx, top + lanes.length * LANE_H);
        ctx.stroke();
      }
      for (const e of tr.events) {
        if (e.at + Math.max(e.ticks, 0.4) < t0 || e.at > tr.t) continue;
        const end = Math.min(e.at + Math.max(e.ticks, 0.4), tr.t);
        const us = unitsOf(e);
        ctx.fillStyle = isSpillTraffic(e) ? colors.spill : colors.signal;
        lanes.forEach((ln, i) => {
          if (!ln.units.some((u) => us.includes(u))) return;
          const bx = Math.max(LABEL_W, x(e.at));
          const bw = Math.max(2, x(end) - bx - 1);
          ctx.fillRect(bx, top + i * LANE_H + 4, bw, LANE_H - 8);
        });
      }
      const cx = Math.round(x(tr.t)) + 0.5;
      ctx.strokeStyle = colors.cursor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, top - 4);
      ctx.lineTo(cx, top + lanes.length * LANE_H);
      ctx.stroke();
      y0 = top + lanes.length * LANE_H + 8;
    }
  }, [tracks, width, height, windowTicks]);

  const onMove = (ev: React.MouseEvent) => {
    const rect = (ev.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    let y0 = 4;
    for (const tr of tracks) {
      const lanes = LANES[tr.isa];
      const top = y0 + HEAD_H;
      const bottom = top + lanes.length * LANE_H;
      if (my >= top && my < bottom && mx >= LABEL_W) {
        const lane = lanes[Math.floor((my - top) / LANE_H)]!;
        const t1 = Math.max(tr.t, windowTicks);
        const tick = t1 - windowTicks + ((mx - LABEL_W) / (width - LABEL_W - 12)) * windowTicks;
        const hit = [...tr.events].reverse().find((e) => e.at <= tick && tick < e.at + Math.max(e.ticks, 0.4) && e.at <= tr.t && unitsOf(e).some((u) => lane.units.includes(u)));
        setTip(hit ? { x: mx, y: my, text: `t ${hit.at}–${hit.at + hit.ticks}: ${describe(hit)}` } : null);
        return;
      }
      y0 = bottom + 8;
    }
    setTip(null);
  };

  return (
    <div className="analyzer" ref={wrapRef}>
      <canvas ref={canvasRef} style={{ width: "100%", height }} onMouseMove={onMove} onMouseLeave={() => setTip(null)} aria-label="Logic analyzer: every microstep per functional unit on the modeled-tick clock" role="img" />
      {tip && (
        <div className="analyzer-tip mono" style={{ left: Math.min(tip.x + 12, width - 360), top: tip.y + 14 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}
