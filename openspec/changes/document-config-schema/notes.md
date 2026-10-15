# Notes

## Probe answers (the two TODO-named checks)

The TODO's two open questions, answered with code and pinned as regression
guards in `test/schema-probe.test.ts` (zod 4.6.4, converted with
`{ io: "input" }` exactly as `src/config/json-schema.ts:buildJsonSchema` does):

1. **Does `z.toJSONSchema` emit `title` from `.meta()`? — Yes.**
   `.meta({ title })` emits a JSON-Schema `title`. Cosmetic either way (per
   design D1): the documentation pass does not rely on it and adds no titles.
2. **Do descriptions survive the `.prefault({})` wrappers around each
   section? — Yes.** A `.describe()`d field inside a `.prefault({})`-wrapped
   section emits its `description` through `z.toJSONSchema`; no restructuring
   was needed. The working pattern, now pinned by the probe test: per-field
   `.describe()` attaches after `.default(...)`; section-level descriptions
   emit whether attached before or after the wrap, and the convention this
   change follows is before the wrap
   (`.object({...}).strict().describe("...").prefault({})`).
   `.meta({ examples })` also emits, and where a field needs both
   description and examples the two are passed in ONE combined
   `.meta({ description, examples })` call.

## Apply notes

- Guard tests added in `test/json-schema.test.ts`: a recursive walker
  asserting every property entry in the committed schema carries a
  description (properties, object-valued `additionalProperties`/`items`,
  `anyOf` branches), and an examples test asserting `strictChecks`,
  `protectedPaths`, and `rulesets` carry examples that the schema AND the
  runtime both accept.
- The ruleset rule-type list in the `rulesets` description is the same
  indicative list as `harden-ruleset-support`'s schema comment (25 entries as
  of October 2026), maintained by hand — deliberately not an enum.
