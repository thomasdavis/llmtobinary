// Node solver backend (tests and the research CLI): z3-solver's WebAssembly build.
// Import path: @llmtobinary/verify/node — never bundled into the browser or the Cloudflare Worker.

import type { SolverBackend } from "./driver.ts";
import { backendFromZ3, type Z3LowLevel } from "./z3-common.ts";

let cached: Promise<SolverBackend> | null = null;

export function nodeZ3Backend(): Promise<SolverBackend> {
  cached ??= (async () => {
    const mod = (await import("z3-solver")) as unknown as { init(): Promise<{ Z3: Z3LowLevel }> };
    const { Z3 } = await mod.init();
    return backendFromZ3(Z3, "node");
  })();
  return cached;
}
