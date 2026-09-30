import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mustValidate } from "@llmtobinary/validate";
import { runFinite } from "@llmtobinary/runtime";
import { buildManifest, exportBundle, importBundle, memoryStore, openStore, sha256Hex, type ArtifactRecord } from "../src/index.ts";

const bytes = new Uint8Array(readFileSync(new URL("../../../fixtures/square-plus-two.anma", import.meta.url)));

async function record(): Promise<ArtifactRecord> {
  return { sha256: await sha256Hex(bytes), byteLength: bytes.length, bytes, name: "square-plus-two.anma", taskId: "square-plus-two", provenance: { kind: "bundled-fixture", file: "square-plus-two.anma", origin: "PRD", modelOutput: false }, annotations: null, annotationsSha256: null, responseText: null, status: "task-passed", createdAt: 1 };
}

describe("artifacts", () => {
  it("export/import round-trips bytes, replay inputs, and run outcome fields", async () => {
    const a = await record();
    const inputs = [{ t: "u64" as const, v: "12" }];
    const config = { fastSlots: 4, policy: "fifo-v1" as const, trace: false };
    const result = runFinite(mustValidate(bytes), inputs, { config });
    const manifest = await buildManifest({ specSha256: "x".repeat(64), buildCommit: "c", deploymentId: null, artifact: a, validationOk: true, checker: "check/1", testReport: null, runs: [{ config, inputs, ticks: [], result }] });
    expect(manifest.artifact.sha256).toBe("d3f7f9e0446680bd1f5d20534d2a413df893e891f7e78f26f37cbe75b48405c1");
    expect(manifest.runs[0]!.returnValue).toEqual({ t: "u64", v: "146" });
    expect(manifest.generation.loopTranscriptIncluded).toBe(false);
    const text = exportBundle(manifest, a, { id: "square-plus-two" }, { inputs, ticks: [] });
    expect(text).not.toContain("promptHistory");
    const back = await importBundle(text);
    expect(Array.from(back.bytes)).toEqual(Array.from(bytes));
    expect(back.sha256).toBe(a.sha256);
    expect(back.replay?.inputs).toEqual(inputs);
    expect(back.warnings[0]).toMatch(/unverified/);
  });
  it("the bytes win over a lying manifest; oversized or foreign bundles are rejected", async () => {
    const a = await record();
    const manifest = await buildManifest({ specSha256: "x", buildCommit: "c", deploymentId: null, artifact: { ...a, sha256: "0".repeat(64) }, validationOk: true, checker: "c", testReport: null, runs: [] });
    const r = await importBundle(exportBundle(manifest, a, null, null));
    expect(r.warnings.some((w) => w.includes("the bytes win"))).toBe(true);
    await expect(importBundle("{}")).rejects.toThrow(/not an llmtobinary bundle/);
    await expect(importBundle("x".repeat(9 * 1024 * 1024))).rejects.toThrow(/exceeds/);
  });
  it("falls back to memory when IndexedDB is unavailable", async () => {
    const s = await openStore(undefined);
    expect(s.persistent).toBe(false);
    const m = memoryStore();
    const a = await record();
    await m.putArtifact(a);
    expect((await m.getArtifact(a.sha256))?.name).toBe("square-plus-two.anma");
    await m.clear();
    expect(await m.listArtifacts()).toEqual([]);
  });
});
