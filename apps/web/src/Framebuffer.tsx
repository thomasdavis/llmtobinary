import { useEffect, useRef, useState } from "react";
import { KEYS } from "@llmtobinary/spec";
import type { MachineClient } from "./machine-client.ts";

const KEY_CODES: Record<string, number> = { ArrowLeft: 0, ArrowRight: 1, ArrowUp: 2, ArrowDown: 3, " ": 4, Enter: 5, Escape: 6 };

/** The 256×144 framebuffer; when the program reads input, focusing it sends keys to the next tick. */
export function Framebuffer({ frame, interactive, machine, autoFocus = false }: { frame: Uint8ClampedArray | null; interactive: boolean; machine: MachineClient; autoFocus?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    if (!frame) {
      ctx.clearRect(0, 0, 256, 144);
      return;
    }
    const buf = new Uint8ClampedArray(frame.length);
    buf.set(frame);
    ctx.putImageData(new ImageData(buf, 256, 144), 0, 0);
  }, [frame]);
  useEffect(() => {
    if (autoFocus && interactive) ref.current?.focus();
  }, [autoFocus, interactive]);
  const key = (e: React.KeyboardEvent, down: boolean) => {
    const k = KEY_CODES[e.key];
    if (k === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    machine.keys = down ? machine.keys | (1 << k) : machine.keys & ~(1 << k);
  };
  return (
    <div className="fb-wrap">
      <h3>Framebuffer 256×144</h3>
      <canvas ref={ref} width={256} height={144} className="fb" tabIndex={interactive ? 0 : -1} aria-label={interactive ? `Framebuffer; focus to send keys ${KEYS.join(", ")}` : "Framebuffer"} onKeyDown={(e) => key(e, true)} onKeyUp={(e) => key(e, false)} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); machine.keys = 0; }} />
      {interactive && <p className="muted small">{focused ? "Keys go to the next tick: ← → ↑ ↓ Space Enter Esc." : "Click the framebuffer to send keys. Ticks are recorded for exact replay."}</p>}
    </div>
  );
}
