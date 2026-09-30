// The candidate envelope (PRD Section 7.2) and the two function tools of the agentic loop.

export const CANDIDATE_SCHEMA_NAME = "anma_candidate_v1";

const nullableString = { type: ["string", "null"] } as const;

export const candidateEnvelopeSchema = {
  type: "object",
  properties: {
    isa: { type: "string", enum: ["ANMA-1"] },
    hex: { type: "string" },
    annotations: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            summary: { type: "string" },
            params: {
              type: "array",
              items: {
                type: "object",
                properties: { function: { type: "integer" }, index: { type: "integer" }, name: { type: "string" } },
                required: ["function", "index", "name"],
                additionalProperties: false,
              },
            },
            records: {
              type: "array",
              items: {
                type: "object",
                properties: { index: { type: "integer" }, claim: nullableString, note: nullableString },
                required: ["index", "claim", "note"],
                additionalProperties: false,
              },
            },
            contracts: {
              type: "array",
              items: {
                type: "object",
                properties: { function: { type: "integer" }, requires: nullableString, ensures: nullableString },
                required: ["function", "requires", "ensures"],
                additionalProperties: false,
              },
            },
            invariants: {
              type: "array",
              items: {
                type: "object",
                properties: { function: { type: "integer" }, block: { type: "integer" }, expr: { type: "string" } },
                required: ["function", "block", "expr"],
                additionalProperties: false,
              },
            },
            examples: {
              type: "array",
              items: {
                type: "object",
                properties: { inputs: { type: "array", items: { type: "string" } }, result: nullableString, terminal: nullableString },
                required: ["inputs", "result", "terminal"],
                additionalProperties: false,
              },
            },
          },
          required: ["summary", "params", "records", "contracts", "invariants", "examples"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["isa", "hex", "annotations"],
  additionalProperties: false,
} as const;

export const CHECK_TOOL = "check_candidate" as const;
export const SUBMIT_TOOL = "submit_candidate" as const;
export type ToolName = typeof CHECK_TOOL | typeof SUBMIT_TOOL;

export const TOOLS = [
  {
    type: "function" as const,
    name: CHECK_TOOL,
    description:
      "Statically decode and validate a complete ANMA-1 candidate and cross-check its annotations. " +
      "Never executes the program and never returns corrected bytes. Returns a diagnostic report.",
    strict: true,
    parameters: candidateEnvelopeSchema as unknown as Record<string, unknown>,
  },
  {
    type: "function" as const,
    name: SUBMIT_TOOL,
    description: "Submit a complete ANMA-1 candidate for independent validation and testing in the visitor's browser.",
    strict: true,
    parameters: candidateEnvelopeSchema as unknown as Record<string, unknown>,
  },
];
