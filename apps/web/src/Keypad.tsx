// Controls for programs that read input (the event-input device: seven keys sampled once per
// tick). On a keyboard the keys work anywhere on the page while the program runs (not while you
// type in a field); on a touch screen the buttons are the keys. A key lights only while it is
// really held, and a quick tap still reaches the program on the next tick.

import { useEffect, useState } from "react";
import { KEYS } from "@llmtobinary/spec";
import type { MachineClient, MachineView } from "./machine-client.ts";

/** Keyboard keys for each of the machine's seven keys (KEYS order: Left Right Up Down Space Enter Escape). */
const KEY_CODES: Record<string, number> = { ArrowLeft: 0, ArrowRight: 1, ArrowUp: 2, ArrowDown: 3, " ": 4, Enter: 5, Escape: 6 };
const bit = (name: (typeof KEYS)[number]) => KEYS.indexOf(name);

function typingInField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

export function Keypad({ machine, view }: { machine: MachineClient; view: MachineView }) {
  const [held, setHeld] = useState(machine.keys);
  const [used, setUsed] = useState(false);
  const [touch, setTouch] = useState(coarse);
  const live = view.status === "running" || view.status === "waiting-input";

  useEffect(() => machine.subscribeKeys(setHeld), [machine]);
  useEffect(() => {
    const m = window.matchMedia("(pointer: coarse)");
    const on = () => setTouch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  // While the program runs, the keyboard drives it from anywhere on the page.
  useEffect(() => {
    if (!live) {
      machine.releaseAll();
      return;
    }
    const down = (e: KeyboardEvent) => {
      const k = KEY_CODES[e.key];
      if (k === undefined || typingInField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("dialog[open]")) return; // a modal is in front of the program
      e.preventDefault(); // arrows and Space would otherwise scroll the page
      if (!e.repeat) machine.press(k);
      setUsed(true);
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY_CODES[e.key];
      if (k !== undefined) machine.release(k);
    };
    const reset = () => machine.releaseAll();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
      machine.releaseAll();
    };
  }, [live, machine]);

  const key = (name: (typeof KEYS)[number], label: string, cls: string, aria: string) => {
    const b = bit(name);
    const on = (held & (1 << b)) !== 0;
    return (
      <button
        type="button"
        className={`kp-key ${cls}${on ? " is-down" : ""}`}
        aria-label={aria}
        aria-pressed={on}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          machine.press(b);
          setUsed(true);
        }}
        onPointerUp={() => machine.release(b)}
        onPointerCancel={() => machine.release(b)}
        onLostPointerCapture={() => machine.release(b)}
        onContextMenu={(e) => e.preventDefault()}
      >
        {label}
      </button>
    );
  };

  const status = !live
    ? { text: "Press Run, then play with these keys", tone: "idle" }
    : used
      ? { text: "Listening to your keys", tone: "live" }
      : { text: touch ? "Your turn: hold a button" : "Your turn: press a key", tone: "call" };

  return (
    <section className={`keypad${live ? " is-live" : ""}${touch ? " is-touch" : ""}`} aria-label="Controls for this program">
      <div className="keypad-head">
        <h3>Controls</h3>
        <span className={`keypad-status tone-${status.tone}`} role="status">{status.text}</span>
      </div>
      <div className="keypad-pad">
        <div className="kp-dpad">
          {key("Up", "↑", "kp-up", "Up arrow")}
          {key("Left", "←", "kp-left", "Left arrow")}
          {key("Right", "→", "kp-right", "Right arrow")}
          {key("Down", "↓", "kp-down", "Down arrow")}
        </div>
        <div className="kp-actions">
          {key("Space", "Space", "kp-space", "Space")}
          {key("Enter", "Enter", "kp-enter", "Enter")}
          {key("Escape", "Esc", "kp-esc", "Escape")}
        </div>
      </div>
      <p className="keypad-hint">
        {touch ? "Hold the buttons; several at once works." : "Use your keyboard (arrow keys, Space, Enter, Esc) anywhere on the page, or click these. The program reads the keys once per tick; every tick is recorded, so a run can be replayed exactly."}
      </p>
    </section>
  );
}
