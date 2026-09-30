// T1 cross-check of record claims against decoded records, with cascade handling:
// once a structural error misaligns the records, later claim mismatches are consequences.

import type { DecodedFile } from "@llmtobinary/decode";
import { Stage, diag, type Diagnostic } from "@llmtobinary/diagnostics";
import { compareClaim } from "./claims.ts";
import type { ParsedAnnotations } from "./schema.ts";

export interface CrossCheckResult {
  diagnostics: Diagnostic[];
  checked: number;
  matched: number;
  /** Claim text keyed by record index, for listings and for attaching to structural diagnostics. */
  claimByRecord: Map<number, string>;
  noteByRecord: Map<number, string>;
}

/**
 * @param structuralFrom record index of the earliest structural (non-annotation) error, or null.
 *   Claims at or after it that mismatch are marked as cascades.
 * @param headerMisaligned true when the header length is inconsistent (every claim beyond the
 *   decodable records is then a cascade).
 */
export function crossCheckClaims(ann: ParsedAnnotations, file: DecodedFile, structuralFrom: number | null, headerMisaligned: boolean): CrossCheckResult {
  const diagnostics: Diagnostic[] = [];
  const claimByRecord = new Map<number, string>();
  const noteByRecord = new Map<number, string>();
  let checked = 0;
  let matched = 0;
  for (const ra of ann.records) {
    if (ra.claimText !== null) claimByRecord.set(ra.index, ra.claimText);
    if (ra.note !== null) noteByRecord.set(ra.index, ra.note);
    const rec = file.records[ra.index];
    const afterStructural = structuralFrom !== null && ra.index >= structuralFrom;
    if (!rec) {
      diagnostics.push(
        diag("ANMA-A-002", {
          message: `Record ${ra.index} is annotated but the file has only ${file.records.length} decodable records.`,
          location: { recordIndex: ra.index },
          found: ra.claimText,
          stage: Stage.ANNOTATIONS,
          cascade: headerMisaligned || structuralFrom !== null,
        }),
      );
      continue;
    }
    if (!ra.claim) continue;
    checked++;
    const cmp = compareClaim(ra.claim, rec);
    if (cmp.matches) {
      matched++;
      continue;
    }
    diagnostics.push(
      diag("ANMA-A-004", {
        message: `Record ${ra.index} is claimed as ${ra.claimText} but decodes as ${cmp.decodedText}.`,
        location: { recordIndex: ra.index, byteOffset: rec.offset, field: "record.opcode" },
        found: cmp.decodedText,
        expected: `the claim ${ra.claimText}`,
        derived: cmp.differences.join("; "),
        claim: ra.claimText,
        stage: Stage.ANNOTATIONS,
        cascade: afterStructural,
      }),
    );
  }
  return { diagnostics, checked, matched, claimByRecord, noteByRecord };
}
