// The artifact currently shown in the inspector and machine: an immutable byte copy plus its
// independent validation, decoded view, and (optional) annotations.
import { checkCandidate, sha256Hex } from "@llmtobinary/check";
import { validateBytes, type Module } from "@llmtobinary/validate";
import { decodeFile, type DecodedFile } from "@llmtobinary/decode";
import type { ParsedAnnotations } from "@llmtobinary/annotations";
import type { CheckReport, TestReport } from "@llmtobinary/protocol";
import type { ArtifactRecord, Provenance } from "@llmtobinary/artifacts";

export interface LoadedArtifact {
  record: ArtifactRecord;
  check: CheckReport;
  module: Module | null;
  decoded: DecodedFile | null;
  annotations: ParsedAnnotations | null;
  test: TestReport | null;
  witness: unknown;
}

export async function loadArtifact(input: { bytes: Uint8Array; annotations?: unknown; name: string; taskId: string | null; provenance: Provenance; responseText?: string | null; allowedFeatures: number }): Promise<LoadedArtifact> {
  const bytes = input.bytes.slice(); // private immutable copy
  const out = input.annotations !== undefined && input.annotations !== null
    ? await checkCandidate({ envelope: { isa: "ANMA-1", hex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""), annotations: input.annotations } }, { allowedFeatures: input.allowedFeatures, maxCandidateBytes: 1024 * 1024 })
    : await checkCandidate({ bytes }, { allowedFeatures: input.allowedFeatures, maxCandidateBytes: 1024 * 1024 });
  const v = validateBytes(bytes, { allowedFeatures: input.allowedFeatures });
  const decoded = decodeFile(bytes).file;
  const record: ArtifactRecord = {
    sha256: out.report.sha256 ?? (await sha256Hex(bytes)),
    byteLength: bytes.length,
    bytes,
    name: input.name,
    taskId: input.taskId,
    provenance: input.provenance,
    annotations: input.annotations ?? null,
    annotationsSha256: out.report.annotations.sha256,
    responseText: input.responseText ?? null,
    status: out.report.ok ? "valid" : "invalid",
    createdAt: Date.now(),
  };
  return { record, check: out.report, module: v.ok ? v.module : null, decoded, annotations: out.annotations, test: null, witness: null };
}
