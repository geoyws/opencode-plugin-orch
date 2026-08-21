import { z } from "zod";

export const MAX_OUTPUT_SCHEMA_CHARS = 32_768;

function assertNoReferences(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoReferences(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") {
      throw new Error("output schemas may not use $ref");
    }
    assertNoReferences(child);
  }
}

export function compileOutputSchema(schema: Record<string, unknown>): z.ZodType {
  let encoded: string;
  try {
    encoded = JSON.stringify(schema);
  } catch (err) {
    throw new Error(
      `output schema is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (encoded.length > MAX_OUTPUT_SCHEMA_CHARS) {
    throw new Error(`output schema exceeds ${MAX_OUTPUT_SCHEMA_CHARS} characters`);
  }
  assertNoReferences(schema);
  try {
    return z.fromJSONSchema(schema as never);
  } catch (err) {
    throw new Error(
      `unsupported output schema: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function validateOutputSchema(schema: Record<string, unknown>): string | undefined {
  try {
    compileOutputSchema(schema);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function parseStructuredOutput(
  text: string,
  schema: Record<string, unknown>
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const result = compileOutputSchema(schema).safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`output does not match schema: ${details}`);
  }
  return result.data;
}
