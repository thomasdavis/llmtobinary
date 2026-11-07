// The library as generation sees it: each library slot's default candidate. The board's rule picks
// the candidate, so evidence decides what can be imported and popularity never does.

import { catalogAccess, eligibleCatalog, type LibraryAccess, type LibraryEntry, type LibraryFunction } from "@llmtobinary/link/library";
import { objectId } from "@llmtobinary/registry";
import { listSlots } from "./board.ts";

export const libraryGenerationEnabled = (env: Env): boolean => env.LIBRARY_GENERATION === "true" && !!env.REGISTRY && !!env.COMMUNITY_DB;

/** Every library slot with a default candidate. eligibleCatalog then applies the evidence policy. */
export async function loadLibrary(env: Env): Promise<LibraryEntry[]> {
  const { slots } = await listSlots(env);
  return slots
    .filter((s) => s.kind === "library" && s.winner)
    .map((s) => ({ slot: s.id, title: s.title, objectId: s.winner!.object_id, evidence: s.winner!.evidence_class, features: s.features, depends: JSON.parse(s.depends) as string[], functions: JSON.parse(s.interface) as LibraryFunction[] }));
}

/** Reads a package's bytes and refuses them unless they hash to the ID the board named. */
async function packageBytes(env: Env, id: string): Promise<Uint8Array | null> {
  const o = await env.REGISTRY!.get(`objects/sha256/${id.slice(7)}`);
  if (!o) return null;
  const bytes = new Uint8Array(await o.arrayBuffer());
  return (await objectId(bytes)) === id ? bytes : null;
}

export async function libraryCatalog(env: Env, allowedFeatures: number): Promise<LibraryEntry[]> {
  return eligibleCatalog(await loadLibrary(env), allowedFeatures);
}

export async function libraryAccess(env: Env, allowedFeatures: number): Promise<LibraryAccess> {
  return catalogAccess(await libraryCatalog(env, allowedFeatures), (id) => packageBytes(env, id), allowedFeatures);
}
