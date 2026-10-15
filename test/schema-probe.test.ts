/**
 * Regression guard for the zod JSON-Schema emission behaviour that the
 * documentation pass over `src/config/schema.ts` depends on.
 *
 * Each assertion pins an answer observed from zod 4.6.4 using the same
 * `{ io: "input" }` options the real generator passes
 * (`src/config/json-schema.ts:buildJsonSchema`). If a future zod changes the
 * output, these tests fail loudly rather than letting `.describe()` calls
 * silently stop documenting the published schema.
 *
 * The schemas here are deliberately self-contained: importing the real config
 * schema would make this probe fail for unrelated reasons.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

/** Convert exactly as the real generator does. */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

/** Walk `properties` down a path without fighting the JSONSchema union type. */
function property(root: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let node = root;
  for (const key of path) {
    node = (node.properties as Record<string, Record<string, unknown>>)[key];
  }
  return node;
}

describe("zod JSON-Schema emission (probe)", () => {
  it("keeps a field's description inside a .prefault({}) section", () => {
    const root = z
      .object({
        section: z
          .object({
            field: z.string().describe("field doc"),
          })
          .strict()
          .prefault({}),
      })
      .strict();

    // Yes: per-field `.describe()` survives the prefault wrapper, so it is the
    // carrier for per-field documentation.
    expect(property(toJsonSchema(root), "section", "field").description).toBe("field doc");
  });

  it("emits title from .meta({ title })", () => {
    const root = z
      .object({
        field: z.string().meta({ title: "Field Title" }),
      })
      .strict();

    // Yes: `.meta({ title })` emits a JSON-Schema `title`. This is cosmetic
    // only; the documentation pass does not rely on it.
    expect(property(toJsonSchema(root), "field").title).toBe("Field Title");
  });

  it("keeps a section description whether .describe() is attached before or after the .prefault({}) wrap", () => {
    const describedBefore = z
      .object({ x: z.string() })
      .strict()
      .describe("section doc")
      .prefault({});
    const describedAfter = z
      .object({ x: z.string() })
      .strict()
      .prefault({})
      .describe("section doc");

    // Both orders work. The documented pattern is to attach the description
    // BEFORE the wrap, matching the per-field `.describe()` chain and keeping
    // the field/vs-section convention uniform.
    expect(
      property(toJsonSchema(z.object({ before: describedBefore }).strict()), "before").description,
    ).toBe("section doc");
    expect(
      property(toJsonSchema(z.object({ after: describedAfter }).strict()), "after").description,
    ).toBe("section doc");
  });

  it("emits examples from .meta({ examples })", () => {
    const root = z
      .object({
        field: z.string().meta({ examples: ["a", "b"] }),
      })
      .strict();

    // Yes: `.meta({ examples })` is the carrier for the worked examples added
    // in the documentation pass.
    expect(property(toJsonSchema(root), "field").examples).toEqual(["a", "b"]);
  });
});
