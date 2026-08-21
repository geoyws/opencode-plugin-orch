import { describe, expect, it } from "bun:test";
import {
  MAX_OUTPUT_SCHEMA_CHARS,
  compileOutputSchema,
  parseStructuredOutput,
  validateOutputSchema,
} from "../src/core/structured-output.js";

describe("structured output schemas", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer", minimum: 0 },
    },
    required: ["name", "count"],
    additionalProperties: false,
  };

  it("compiles and parses a matching JSON value", () => {
    expect(compileOutputSchema(schema)).toBeDefined();
    expect(parseStructuredOutput('{"name":"alpha","count":2}', schema)).toEqual({
      name: "alpha",
      count: 2,
    });
    expect(validateOutputSchema(schema)).toBeUndefined();
  });

  it("rejects non-JSON and schema mismatches with useful paths", () => {
    expect(() => parseStructuredOutput("```json\n{}\n```", schema)).toThrow(
      /not valid JSON/
    );
    expect(() => parseStructuredOutput('{"name":"alpha","count":-1}', schema)).toThrow(
      /count:/
    );
    expect(() => parseStructuredOutput('{"name":"alpha"}', schema)).toThrow(/count:/);
  });

  it("rejects references and oversized schemas without fetching anything", () => {
    expect(validateOutputSchema({ $ref: "https://example.test/schema" })).toContain("$ref");
    expect(
      validateOutputSchema({ type: "string", description: "x".repeat(MAX_OUTPUT_SCHEMA_CHARS) })
    ).toContain("exceeds");
  });
});
