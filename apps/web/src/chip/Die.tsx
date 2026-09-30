import { memo } from "react";
import type { MicroEvent } from "@llmtobinary/protocol";
import { VIEW_H, VIEW_W, grid, pointAt, wiresOf, type Floorplan, type Rect, type UnitGeom } from "./geometry.ts";
import { isSpillTraffic, unitsOf } from "./units.ts";
import type { ChipViewModel } from "./viewmodel.ts";

export interface ActiveEvent {
  e: MicroEvent;
  /** 0..1 progress through the event's modeled duration. */
  p: number;
}

export interface Glow {
  level: number;
  spill: boolean;
}

const MEM_COLS = 16;
const MEM_ROWS = 8;
const MEM_CELLS = MEM_COLS * MEM_ROWS;
const IMEM_ROW = 24;

function trunc(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Static layer: die, substrate grid, bond pads, traces, unit bodies, labels. */
const StaticLayer = memo(function StaticLayer({ plan }: { plan: Floorplan }) {
  const pads: Rect[] = [];
  for (let x = 90; x < VIEW_W - 60; x += 64) {
    pads.push({ x, y: 30, w: 16, h: 12 }, { x, y: VIEW_H - 42, w: 16, h: 12 });
  }
  for (let y = 90; y < VIEW_H - 60; y += 64) {
    pads.push({ x: 30, y, w: 12, h: 16 }, { x: VIEW_W - 42, y, w: 12, h: 16 });
  }
  return (
    <g>
      <defs>
        <pattern id="chip-substrate" width={32} height={32} patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" className="die-grid-line" />
        </pattern>
      </defs>
      <rect className="die" x={16} y={16} width={VIEW_W - 32} height={VIEW_H - 32} rx={8} />
      <rect className="die-grid" fill="url(#chip-substrate)" x={16} y={16} width={VIEW_W - 32} height={VIEW_H - 32} rx={8} />
      {pads.map((p, i) => (
        <rect key={i} className="pad" x={p.x} y={p.y} width={p.w} height={p.h} rx={1.5} />
      ))}
      {plan.wires.map((w) => (
        <polyline key={w.id} className={`trace${w.spill ? " trace-spill" : ""}`} points={w.points.map((p) => p.join(",")).join(" ")} />
      ))}
      {plan.units.map((u) => (
        <UnitBody key={u.unit} u={u} />
      ))}
    </g>
  );
});

function UnitBody({ u }: { u: UnitGeom }) {
  const cls = `unit${u.inactive ? " unit-inactive" : ""}`;
  if (u.unit === "alu") {
    const inset = 36;
    const pts = [
      [u.x, u.y],
      [u.x + u.w, u.y + inset],
      [u.x + u.w, u.y + u.h - inset],
      [u.x, u.y + u.h],
    ];
    return (
      <g className={cls}>
        <polygon className="unit-body" points={pts.map((p) => p.join(",")).join(" ")} />
        <text className="unit-label" x={u.x + 22} y={u.y + 58}>{u.label}</text>
        {u.sub && <text className="unit-sub" x={u.x + 22} y={u.y + 80}>{u.sub}</text>}
      </g>
    );
  }
  return (
    <g className={cls}>
      <rect className="unit-body" x={u.x} y={u.y} width={u.w} height={u.h} rx={4} />
      <text className="unit-label" x={u.x + 16} y={u.y + 28}>{u.label}</text>
      {u.sub && <text className="unit-sub" x={u.x + 16} y={u.y + 48}>{u.sub}</text>}
    </g>
  );
}

function glowStyle(g: Glow | undefined): React.CSSProperties | undefined {
  if (!g || g.level < 0.02) return undefined;
  return { ["--g" as string]: g.level.toFixed(3) };
}

export function Die(props: {
  plan: Floorplan;
  vm: ChipViewModel;
  active: ActiveEvent[];
  glows: Map<string, Glow>;
  records: { rec: number; text: string }[];
  memCapacity: number;
  reducedMotion: boolean;
  label: string;
}) {
  const { plan, vm, active, glows, records } = props;
  const cellHit = new Map<number, boolean>();
  const memHit = new Map<number, boolean>();
  for (const { e } of active) {
    const spill = isSpillTraffic(e);
    if ("slot" in e && typeof e.slot === "number" && e.u !== "save" && e.u !== "restore") cellHit.set(e.slot, spill);
    if ("entry" in e && typeof e.entry === "number") memHit.set(e.entry, true);
    if (e.u === "reg-read" || e.u === "reg-write" || e.u === "save" || e.u === "restore") cellHit.set(e.reg, spill);
    if (e.u === "save" || e.u === "restore") memHit.set(e.slot, true);
  }
  const unitGeom = (u: string) => plan.units.find((x) => x.unit === u);
  const cells = vm.cells;
  const g = grid(plan.cellArea, cells.length);
  const memArea = plan.memArea;
  const mcw = (memArea.w - (MEM_COLS - 1) * 3) / MEM_COLS;
  const mch = (memArea.h - (MEM_ROWS - 1) * 3) / MEM_ROWS;
  const imem = unitGeom("imem")!;
  const recIdx = records.findIndex((r) => r.rec === vm.rec);
  const imemRows = Math.max(3, Math.floor((imem.h - 66) / IMEM_ROW));
  const start = Math.max(0, Math.min(records.length - imemRows, (recIdx < 0 ? 0 : recIdx) - Math.floor(imemRows / 2)));
  const window = records.slice(start, start + imemRows);
  const packets: { x: number; y: number; spill: boolean; key: string }[] = [];
  const hotWires = new Map<string, boolean>();
  for (const { e, p } of active) {
    const spill = isSpillTraffic(e);
    const ws = wiresOf(e).filter((id) => plan.wires.some((w) => w.id === id));
    ws.forEach((id, i) => {
      hotWires.set(id, spill);
      if (props.reducedMotion) return;
      const lo = i / ws.length;
      const hi = (i + 1) / ws.length;
      if (p < lo || p > hi) return;
      const w = plan.wires.find((x) => x.id === id)!;
      const [x, y] = pointAt(w.points, (p - lo) / (hi - lo));
      packets.push({ x, y, spill, key: `${e.at}-${e.u}-${id}` });
    });
  }
  const aluG = unitGeom("alu")!;
  const dir = unitGeom("directory")!;
  const staging = unitGeom("staging")!;
  const stack = unitGeom("stack")!;
  const heapU = unitGeom("heap")!;
  const fetch = unitGeom("fetch")!;
  const decode = unitGeom("decode")!;
  const memUsed = vm.mem.size;
  const memUnit = unitGeom(plan.isa === "ANMR-1" ? "spill" : "backing")!;
  return (
    <svg className="die-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={props.label} preserveAspectRatio="xMidYMid meet">
      <StaticLayer plan={plan} />

      {/* live wire overlays */}
      {plan.wires.map((w) =>
        hotWires.has(w.id) ? <polyline key={w.id} className={`wire-hot${hotWires.get(w.id) ? " is-spill" : ""}`} points={w.points.map((p) => p.join(",")).join(" ")} /> : null,
      )}

      {/* unit glow overlays */}
      {plan.units.map((u) => {
        const gl = glows.get(u.unit);
        if (!gl || gl.level < 0.02 || u.inactive) return null;
        return u.unit === "alu" ? null : <rect key={`glow-${u.unit}`} className={`unit-glow${gl.spill ? " is-spill" : ""}`} style={glowStyle(gl)} x={u.x} y={u.y} width={u.w} height={u.h} rx={4} />;
      })}
      {(() => {
        const gl = glows.get("alu");
        if (!gl || gl.level < 0.02) return null;
        const inset = 36;
        const pts = [[aluG.x, aluG.y], [aluG.x + aluG.w, aluG.y + inset], [aluG.x + aluG.w, aluG.y + aluG.h - inset], [aluG.x, aluG.y + aluG.h]];
        return <polygon className="unit-glow" style={glowStyle(gl)} points={pts.map((p) => p.join(",")).join(" ")} />;
      })()}

      {/* instruction memory window */}
      <g className="imem">
        {window.map((r, i) => {
          const y = imem.y + 76 + i * IMEM_ROW;
          const cur = r.rec === vm.rec;
          return (
            <g key={r.rec} className={cur ? "imem-row is-current" : "imem-row"}>
              {cur && <rect className="imem-cursor" x={imem.x + 10} y={y - 17} width={imem.w - 20} height={IMEM_ROW - 1} rx={3} />}
              <text className="mono imem-idx" x={imem.x + 22} y={y}>{String(r.rec).padStart(4, " ")}</text>
              <text className="mono imem-text" x={imem.x + 78} y={y}>{trunc(r.text, 38)}</text>
            </g>
          );
        })}
      </g>

      {/* fetch / decode readouts */}
      <text className="mono readout" x={fetch.x + 16} y={fetch.y + 70}>{vm.rec !== null ? `record ${vm.rec}` : "—"}</text>
      <text className="mono readout" x={decode.x + 16} y={decode.y + 70}>{trunc(vm.text.replace(/^\(/, "").split(" ")[0] ?? "", 14) || "—"}</text>

      {/* directory */}
      {!dir.inactive && (
        <g>
          <text className="mono readout" x={dir.x + 16} y={dir.y + 92}>{`live values ${cells.filter((c) => c.value).length + memUsed}`}</text>
          <text className="mono readout dim" x={dir.x + 16} y={dir.y + 124}>{trunc(vm.lastLookup ?? "no lookup yet", 44)}</text>
        </g>
      )}

      {/* storage cells: fast slots (ANMA) or register file (ANMR) */}
      <g className="cells">
        {cells.map((c, i) => {
          const col = i % g.cols;
          const row = Math.floor(i / g.cols);
          const x = plan.cellArea.x + col * (g.cw + g.gap);
          const y = plan.cellArea.y + row * (g.ch + g.gap);
          const hit = cellHit.get(i);
          const big = g.ch > 44;
          return (
            <g key={i} className={`cell${c.value ? " is-full" : ""}${hit !== undefined ? (hit ? " is-hot is-spill" : " is-hot") : ""}`}>
              <rect x={x} y={y} width={g.cw} height={g.ch} rx={3} />
              <text className="mono cell-idx" x={x + 6} y={y + (big ? 16 : g.ch / 2 + 4)}>{plan.isa === "ANMR-1" ? `r${i}` : `s${i}`}</text>
              {c.value && big && <text className="mono cell-val" x={x + 6} y={y + g.ch / 2 + 6}>{trunc(c.value.split(".").pop() ?? c.value, 9)}</text>}
              {c.payload && big && g.ch > 60 && <text className="mono cell-payload" x={x + 6} y={y + g.ch - 10}>{trunc(c.payload, Math.max(6, Math.floor(g.cw / 9)))}</text>}
            </g>
          );
        })}
      </g>

      {/* latches */}
      {plan.latchBoxes &&
        (Object.entries(plan.latchBoxes) as ["A" | "B" | "R", Rect][]).map(([name, r]) => (
          <g key={name} className={`latch${vm.latches[name] !== null ? " is-full" : ""}`}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={3} />
            <text className="latch-name" x={r.x + 10} y={r.y + 24}>{name}</text>
            <text className="mono latch-val" x={r.x + 10} y={r.y + 54}>{trunc(vm.latches[name], 11) || "—"}</text>
          </g>
        ))}

      {/* ALU readout */}
      <text className="mono readout" x={aluG.x + 22} y={aluG.y + 130}>{vm.alu ? trunc(vm.alu.op.replace(/_U64$/, ""), 14) : "idle"}</text>
      <text className="mono readout dim" x={aluG.x + 22} y={aluG.y + 158}>{vm.alu ? trunc(`= ${vm.alu.result}`, 20) : ""}</text>

      {/* backing SRAM / spill memory */}
      <g className="mem">
        {Array.from({ length: MEM_CELLS }, (_, i) => {
          if (i >= props.memCapacity) return null;
          const col = i % MEM_COLS;
          const row = Math.floor(i / MEM_COLS);
          const x = memArea.x + col * (mcw + 3);
          const y = memArea.y + row * (mch + 3);
          return <rect key={i} className={`mem-cell${vm.mem.has(i) ? " is-full" : ""}${memHit.has(i) ? " is-hot" : ""}`} x={x} y={y} width={mcw} height={mch} rx={1.5} />;
        })}
        <text className="mono mem-count" x={memUnit.x + memUnit.w - 16} y={memUnit.y + 28} textAnchor="end">
          {`${memUsed.toLocaleString()} / ${props.memCapacity.toLocaleString()} in use`}
        </text>
        {props.memCapacity > MEM_CELLS && (
          <text className="mono unit-sub" x={memUnit.x + memUnit.w - 16} y={memUnit.y + 48} textAnchor="end">
            {`first ${MEM_CELLS} shown`}
          </text>
        )}
      </g>

      {/* typed heap: live allocations as tiles, size, and the last operation */}
      {!heapU.inactive && (
        <g className="heap">
          <text className="mono readout" x={heapU.x + 16} y={heapU.y + 76}>
            {vm.heap.allocations ? `${vm.heap.allocations} allocation${vm.heap.allocations === 1 ? "" : "s"} · ${vm.heap.bytes.toLocaleString()} B` : "no allocations"}
          </text>
          {vm.heap.last && <text className="mono readout dim" x={heapU.x + 16} y={heapU.y + 102}>{`last: ${vm.heap.last}`}</text>}
          {Array.from({ length: Math.min(vm.heap.allocations, 24) }, (_, i) => (
            <rect key={i} className="heap-tile" x={heapU.x + 16 + i * 17} y={heapU.y + heapU.h - 28} width={13} height={13} rx={2} />
          ))}
        </g>
      )}

      {/* staging and stack */}
      {!staging.inactive && (
        <text className="mono readout" x={staging.x + 16} y={staging.y + 84}>{vm.staged.length ? trunc(vm.staged.join("  "), 44) : "empty"}</text>
      )}
      {!stack.inactive &&
        Array.from({ length: Math.min(vm.depth, 10) }, (_, i) => (
          <rect key={i} className="frame-bar" x={stack.x + 16} y={stack.y + stack.h - 22 - i * 16} width={stack.w - 32} height={12} rx={2} />
        ))}
      {!stack.inactive && <text className="mono unit-sub" x={stack.x + 16} y={stack.y + 72}>{`depth ${vm.depth}`}</text>}
      {plan.isa === "ANMA-1" && vm.lastHost && <text className="mono readout dim" x={590} y={728}>{`last call: ${vm.lastHost}`}</text>}

      {/* data packets travelling the wires (omitted when reduced motion is requested) */}
      {packets.map((pk) =>
        pk.spill ? (
          <rect key={pk.key} className="packet is-spill" x={pk.x - 7} y={pk.y - 7} width={14} height={14} transform={`rotate(45 ${pk.x} ${pk.y})`} />
        ) : (
          <circle key={pk.key} className="packet" cx={pk.x} cy={pk.y} r={7} />
        ),
      )}
    </svg>
  );
}

/** Units a set of active events lights (for glow smoothing in the page). */
export function litUnits(active: ActiveEvent[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const { e } of active) {
    const spill = isSpillTraffic(e);
    for (const u of unitsOf(e)) out.set(u, (out.get(u) ?? false) || spill);
    if (e.u === "host") out.set(e.name.startsWith("terminal") ? "terminal" : e.name.startsWith("display") ? "framebuffer" : "input", false);
  }
  return out;
}
