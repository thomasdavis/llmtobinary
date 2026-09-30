// Regenerate tool-created fixtures and their manifest entries.
//   node --experimental-transform-types --no-warnings tools/fixture-builder/src/build-fixtures.ts [--check]
// The three specification fixtures (return-42, square-plus-two, upstream-capstone-40) are never
// regenerated; their bytes come from the PRD and are verified against published SHA-256.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { validateBytes } from "@llmtobinary/validate";
import { FIXTURES } from "./fixtures.ts";
import { BUILDER_VERSION } from "./builder.ts";

const root = new URL("../../../fixtures/", import.meta.url);
const check = process.argv.includes("--check");
const manifestUrl = new URL("manifest.json", root);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const keep = manifest.fixtures.filter((f: { provenance: { kind: string } }) => f.provenance.kind === "specification-fixture");
const entries = [...keep];
let stale = 0;

for (const def of FIXTURES) {
  const bytes = def.build();
  const v = validateBytes(bytes);
  if (!v.ok) {
    const errs = v.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.rule} ${d.message}`);
    throw new Error(`${def.file} does not validate:\n${errs.join("\n")}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const url = new URL(def.file, root);
  if (def.commit) {
    const existing = existsSync(url) ? new Uint8Array(readFileSync(url)) : null;
    const same = existing !== null && Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) === 0;
    if (!same) {
      stale++;
      if (!check) writeFileSync(url, bytes);
    }
  }
  entries.push({
    file: def.file,
    task: def.task,
    bytes: bytes.length,
    sha256,
    provenance: { kind: "tool-created-fixture", origin: `tools/fixture-builder (${BUILDER_VERSION}): ${def.note}`, modelOutput: false },
  });
}

const next = { ...manifest, fixtures: entries };
const text = JSON.stringify(next, null, 2) + "\n";
if (text !== readFileSync(manifestUrl, "utf8")) {
  stale++;
  if (!check) writeFileSync(manifestUrl, text);
}
if (check && stale) {
  console.error(`${stale} fixture file(s) or manifest entries are stale; run build-fixtures`);
  process.exit(1);
}
console.log(`${FIXTURES.length} tool-created fixtures ${check ? "checked" : "written"}; ${keep.length} specification fixtures kept`);
