import { useEffect, useRef } from "react";

/** The 256×144 framebuffer as last presented. Keys are sent through the Controls panel (Keypad). */
export function Framebuffer({ frame, note = null }: { frame: Uint8ClampedArray | null; note?: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
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
  return (
    <div className="fb-wrap">
      <h3>Framebuffer 256×144</h3>
      <div className="fb-stage">
        <canvas ref={ref} width={256} height={144} className="fb" aria-label="Framebuffer" />
        {/* Over the canvas, so it never pushes the layout down when it appears. */}
        {note && <p className="fb-note small" role="status">{note}</p>}
      </div>
    </div>
  );
}
