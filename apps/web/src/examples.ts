// The examples offered in the simple view: programs the AI wrote (unedited model output, with
// the session they came from) and reference programs made by the project's own tools, labelled
// as such. Bytes are served as static assets.

import type { Provenance } from "@llmtobinary/artifacts";
import examplesManifest from "../../../examples/manifest.json";

const urls = import.meta.glob("../../../examples/*.anma", { query: "?url", import: "default", eager: true }) as Record<string, string>;

export interface AiExample {
  file: string;
  title: string;
  bytes: number;
  sha256: string;
  prompt: string;
  provenance: Extract<Provenance, { kind: "model-generated" }>;
  reasoningEffort: string | null;
  counters: { turns: number; checks: number; outputTokens: number };
  usdSpent: number;
  controls: string;
  /** The model's own annotation sidecar (its examples and contract), exactly as submitted. */
  annotations: unknown;
}

export const AI_EXAMPLES = examplesManifest.examples as AiExample[];

export async function loadExample(file: string): Promise<Uint8Array> {
  const url = urls[`../../../examples/${file}`];
  if (!url) throw new Error(`example ${file} is not bundled`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`example ${file}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Reference programs (tool-written, not AI output) with plain-language names. */
export const REFERENCE_EXAMPLES: { file: string; task: string; title: string; about: string; controls?: string }[] = [
  { file: "ball-paddle.anma", task: "ball-paddle", title: "Pong", about: "A ball bounces; you move the paddle.", controls: "← → move the paddle" },
  { file: "hello.anma", task: "hello", title: "Hello, world", about: "Prints one line of text." },
  { file: "checkerboard.anma", task: "checkerboard", title: "Checkerboard", about: "Colours every pixel of the screen." },
  { file: "fizzbuzz.anma", task: "fizzbuzz", title: "FizzBuzz", about: "The classic counting puzzle." },
  { file: "fibonacci.anma", task: "fibonacci", title: "Fibonacci", about: "A function that calls itself." },
];
