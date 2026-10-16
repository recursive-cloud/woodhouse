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

## Whole-change verification (2026-10-15)

Whole-change verification pass (reviewer-local, openspec-verify-change):
**APPROVED** — no critical issues, no warnings. All gates re-run
independently: `npm test` / `mise run ci` (400 passed, 31 files), `npm
run typecheck`, `npm run schema:check` ("up to date"), `mise run lint`
plus direct `oxlint`/`oxfmt` on the changed files (0 warnings,
formatting correct). All 6 tasks evidenced in the diff; the prose moved
(not duplicated) into `.describe()`/`.meta()` in `src/config/schema.ts`;
the regenerated `schema/woodhouse.schema.json` is byte-for-byte what
`buildJsonSchema` produces; the validation structure is byte-identical
to baseline; the diff stayed within `schema.ts` + the regenerated JSON +
tests, exactly the proposal's Impact list. One follow-up recorded
(non-blocking):

- The `rulesets` description is the single largest string in the file
  (~1200 chars) and is hand-maintained alongside the
  `harden-ruleset-support` schema comment (see the Apply notes above).
  Consider a shared constant or a doc-test pinning the two lists equal,
  so a future rule-type edit cannot silently desync them — the design
  already acknowledges this maintenance burden.

## Follow-through (post-merge, 2026-10-16)

- PR #21 squash-merged as `23ec7fa` ("feat(config): document every field
  in the published JSON schema (#21)"); workspace main rebased clean.
- The documented schema is live on main — acceptance testing on a real
  repository (test-plan Phase 0) is where config authoring against the
  new descriptions gets exercised.
