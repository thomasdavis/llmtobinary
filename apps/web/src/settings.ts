// Visitor settings remembered across visits (this browser only). Every read and write tolerates
// storage being unavailable (private windows, blocked site data): the page then just uses defaults.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

const PREFIX = "llmtobinary.settings.v1.";

export function loadSetting<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return valid(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the setting lasts for this visit only */
  }
}

/** useState that is remembered across visits under `key`. `valid` rejects stale or foreign values. */
export function usePersistentState<T>(key: string, fallback: T, valid: (v: unknown) => boolean = () => true): [T, Dispatch<SetStateAction<T>>] {
  const [v, setV] = useState<T>(() => loadSetting(key, fallback, valid));
  useEffect(() => saveSetting(key, v), [key, v]);
  return [v, setV];
}

export const oneOf =
  <T,>(...xs: readonly T[]) =>
  (v: unknown): boolean =>
    xs.includes(v as T);

export const isBool = (v: unknown): boolean => typeof v === "boolean";
