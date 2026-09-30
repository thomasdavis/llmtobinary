// Die floorplans (SVG user units; viewBox 1600 x 960). Comparable units share positions across the
// two ISAs so side-by-side chips read as the same die with one subsystem swapped:
// ANMA-1 (value directory + fast slots + backing SRAM, managed by hardware) versus
// ANMR-1 (program-visible register file + spill memory, managed by the model's SAVE/RESTORE).

import type { ChipUnit, MicroEvent } from "@llmtobinary/protocol";

export const VIEW_W = 1600;
export const VIEW_H = 960;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UnitGeom extends Rect {
  unit: ChipUnit | "terminal" | "framebuffer" | "input";
  label: string;
  sub?: string;
  /** Present on the die but unused by this ISA's workload (drawn dim, labelled). */
  inactive?: boolean;
}

export type Point = [number, number];

export interface Wire {
  id: string;
  points: Point[];
  /** Backing/spill traffic wires are drawn in the cool signal. */
  spill?: boolean;
}

export interface Floorplan {
  isa: "ANMA-1" | "ANMR-1";
  units: UnitGeom[];
  wires: Wire[];
  /** Where the storage cell grid (fast slots or register file) is drawn. */
  cellArea: Rect;
  /** Where the backing SRAM / spill memory grid is drawn. */
  memArea: Rect;
  latchBoxes: Record<"A" | "B" | "R", Rect> | null;
}

const IMEM: UnitGeom = { unit: "imem", x: 70, y: 70, w: 430, h: 300, label: "Instruction memory", sub: "16-byte records" };
const FETCH: UnitGeom = { unit: "fetch", x: 70, y: 410, w: 200, h: 90, label: "Fetch" };
const DECODE: UnitGeom = { unit: "decode", x: 300, y: 410, w: 200, h: 90, label: "Decode" };
const STAGING: UnitGeom = { unit: "staging", x: 70, y: 540, w: 430, h: 110, label: "Argument staging" };
const STACK: UnitGeom = { unit: "stack", x: 70, y: 690, w: 430, h: 210, label: "Call stack" };
const IO: UnitGeom = { unit: "io", x: 560, y: 670, w: 470, h: 70, label: "I/O bus" };
const TERMINAL: UnitGeom = { unit: "terminal", x: 560, y: 780, w: 145, h: 120, label: "Terminal" };
const FRAMEBUFFER: UnitGeom = { unit: "framebuffer", x: 722, y: 780, w: 145, h: 120, label: "Framebuffer" };
const INPUT: UnitGeom = { unit: "input", x: 885, y: 780, w: 145, h: 120, label: "Input" };
const HEAP: UnitGeom = { unit: "heap", x: 1080, y: 70, w: 440, h: 150, label: "Typed heap" };
const ALU: UnitGeom = { unit: "alu", x: 1270, y: 330, w: 250, h: 220, label: "ALU", sub: "64-bit, exact mod 2^64" };

const commonWires: Wire[] = [
  { id: "imem-fetch", points: [[170, 370], [170, 410]] },
  { id: "fetch-decode", points: [[270, 455], [300, 455]] },
  { id: "decode-fetch", points: [[400, 410], [400, 392], [240, 392], [240, 410]] },
  { id: "stack-staging", points: [[285, 690], [285, 650]] },
  { id: "staging-io", points: [[500, 620], [535, 620], [535, 705], [560, 705]] },
  { id: "io-terminal", points: [[632, 740], [632, 780]] },
  { id: "io-framebuffer", points: [[794, 740], [794, 780]] },
  { id: "io-input", points: [[957, 740], [957, 780]] },
];

export const ANMA_PLAN: Floorplan = {
  isa: "ANMA-1",
  units: [
    IMEM,
    FETCH,
    DECODE,
    { unit: "directory", x: 560, y: 70, w: 470, h: 150, label: "Value directory", sub: "value identity → home" },
    { unit: "slots", x: 560, y: 260, w: 470, h: 370, label: "Fast slots", sub: "fifo-v1" },
    { unit: "latches", x: 1080, y: 260, w: 150, h: 370, label: "Latches" },
    ALU,
    { unit: "backing", x: 1080, y: 670, w: 440, h: 230, label: "Backing SRAM", sub: "8-byte entries" },
    STAGING,
    STACK,
    IO,
    TERMINAL,
    FRAMEBUFFER,
    INPUT,
    HEAP,
  ],
  wires: [
    ...commonWires,
    { id: "decode-directory", points: [[500, 440], [530, 440], [530, 145], [560, 145]] },
    { id: "directory-slots", points: [[795, 220], [795, 260]] },
    { id: "slots-latches", points: [[1030, 400], [1080, 400]] },
    { id: "latches-alu", points: [[1230, 400], [1290, 400]] },
    { id: "alu-latches", points: [[1330, 550], [1330, 596], [1230, 596]] },
    { id: "latches-slots", points: [[1080, 560], [1030, 560]] },
    { id: "backing-latches", points: [[1155, 670], [1155, 630]], spill: true },
    { id: "slots-backing", points: [[1030, 612], [1058, 612], [1058, 740], [1080, 740]], spill: true },
    { id: "backing-slots", points: [[1080, 760], [1044, 760], [1044, 624], [1030, 624]], spill: true },
    { id: "latches-staging", points: [[1105, 630], [1105, 652], [520, 652], [520, 595], [500, 595]] },
    { id: "latches-heap", points: [[1155, 260], [1155, 220]] },
  ],
  cellArea: { x: 576, y: 318, w: 438, h: 296 },
  memArea: { x: 1096, y: 726, w: 408, h: 160 },
  latchBoxes: {
    A: { x: 1096, y: 318, w: 118, h: 72 },
    B: { x: 1096, y: 408, w: 118, h: 72 },
    R: { x: 1096, y: 540, w: 118, h: 72 },
  },
};

export const ANMR_PLAN: Floorplan = {
  isa: "ANMR-1",
  units: [
    IMEM,
    FETCH,
    DECODE,
    { unit: "directory", x: 560, y: 70, w: 470, h: 150, label: "No value directory", sub: "the program names registers itself", inactive: true },
    { unit: "regfile", x: 560, y: 260, w: 470, h: 370, label: "Register file", sub: "program-visible" },
    ALU,
    { unit: "spill", x: 1080, y: 670, w: 440, h: 230, label: "Spill memory", sub: "SAVE / RESTORE written by the model" },
    { ...STAGING, inactive: true },
    { ...STACK, inactive: true },
    { ...IO, inactive: true },
    { ...TERMINAL, inactive: true },
    { ...FRAMEBUFFER, inactive: true },
    { ...INPUT, inactive: true },
    { ...HEAP, inactive: true },
  ],
  wires: [
    ...commonWires,
    { id: "decode-regfile", points: [[500, 440], [530, 440], [530, 420], [560, 420]] },
    { id: "regfile-alu", points: [[1030, 400], [1290, 400]] },
    { id: "alu-regfile", points: [[1330, 550], [1330, 580], [1030, 580]] },
    { id: "regfile-spill", points: [[1030, 612], [1058, 612], [1058, 740], [1080, 740]], spill: true },
    { id: "spill-regfile", points: [[1080, 760], [1044, 760], [1044, 624], [1030, 624]], spill: true },
  ],
  cellArea: { x: 576, y: 318, w: 438, h: 296 },
  memArea: { x: 1096, y: 726, w: 408, h: 160 },
  latchBoxes: null,
};

/** Wires a microstep's data travels along (in order). */
export function wiresOf(e: MicroEvent): string[] {
  switch (e.u) {
    case "fetch": return ["imem-fetch", "fetch-decode", "decode-directory", "decode-regfile"];
    case "hit": return ["directory-slots", "slots-latches"];
    case "miss": return ["backing-latches"];
    case "install": return ["backing-slots"];
    case "evict": return ["slots-backing"];
    case "alu": return ["latches-alu", "alu-latches"];
    case "publish": return ["latches-slots"];
    case "reclaim": return [];
    case "stage": return ["latches-staging"];
    case "heap": return ["latches-heap"];
    case "host": return ["staging-io", e.name.startsWith("terminal") ? "io-terminal" : e.name.startsWith("display") ? "io-framebuffer" : "io-input"];
    case "branch": return ["decode-fetch"];
    case "call":
    case "return": return ["stack-staging"];
    case "reg-read": return ["regfile-alu"];
    case "reg-write": return ["alu-regfile"];
    case "save": return ["regfile-spill"];
    case "restore": return ["spill-regfile"];
  }
}

export function wireLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return len;
}

/** Point at fraction f (0..1) along a polyline. */
export function pointAt(points: Point[], f: number): Point {
  const total = wireLength(points);
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (target <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : target / seg;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    target -= seg;
  }
  return points[points.length - 1]!;
}

/** Grid layout for n cells inside an area. */
export function grid(area: Rect, n: number, maxCols = 8): { cols: number; rows: number; cw: number; ch: number; gap: number } {
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : n <= 64 ? 8 : maxCols;
  const rows = Math.max(1, Math.ceil(n / cols));
  const gap = n > 32 ? 4 : 6;
  return { cols, rows, cw: (area.w - gap * (cols - 1)) / cols, ch: (area.h - gap * (rows - 1)) / rows, gap };
}
