// Bundled fixtures: bytes are emitted as static assets and fetched on demand; the manifest records
// provenance (every bundled fixture is specification- or tool-created, never model output).
import manifest from "../../../fixtures/manifest.json";

const urls = import.meta.glob("../../../fixtures/*.anma", { query: "?url", import: "default", eager: true }) as Record<string, string>;

export interface FixtureEntry {
  file: string;
  task: string;
  bytes: number;
  sha256: string;
  isa?: string;
  provenance: { kind: string; origin: string; modelOutput: boolean };
}

export const FIXTURES: FixtureEntry[] = (manifest.fixtures as FixtureEntry[]).filter((f) => f.isa !== "ANMR-1");

export async function loadFixture(file: string): Promise<Uint8Array> {
  const url = urls[`../../../fixtures/${file}`];
  if (!url) throw new Error(`fixture ${file} is not bundled`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${file}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
