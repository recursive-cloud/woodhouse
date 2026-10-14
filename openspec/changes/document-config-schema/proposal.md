# Proposal

## Why

The generated JSON Schema gives editors completion and validation but almost no hover documentation: `description` exists on only the two `allowedActors` sub-lists plus the document root. The explanatory prose already exists — as TSDoc comments throughout `src/config/schema.ts` — it just never reaches the schema. The fiddliest fields (`strictChecks`, `protectedPaths`, `rulesets`) are the least documented, and after `harden-ruleset-support` lands they are also the most newly-shaped.

## What Changes

- A single pass over `schema.ts`: every field's TSDoc prose moves into `.describe()` (or `.meta({ description })` in zod 4) so it reaches `schema/woodhouse.schema.json` through `z.toJSONSchema` — including the honest prune and typed-conditions text from `harden-ruleset-support`.
- `.meta({ examples })` for the fiddly fields: `strictChecks`, `protectedPaths`, and the rulesets section (rule types listed in the description, `ref_name` conditions, bypass actor shape).
- The two open questions the TODO names get answered and recorded during apply: whether `z.toJSONSchema` emits `title` from `.meta()`, and whether descriptions survive the `.prefault({})` wrappers around each section — with restructuring if either fails.
- The schema-modeline offer stays with the onboarding pull request (`open-onboarding-pr`), which writes new config files; this change only enriches the schema those files are validated against.
- Marking deprecated fields becomes a documented practice for future shape changes; nothing is deprecated today.

## Capabilities

### New Capabilities

- `config-schema`: the published JSON Schema for `woodhouse.yml` — generated from the zod definitions, never hand-edited, drift-checked in CI, kept in parity with the runtime validator, and carrying per-field documentation and examples.

### Modified Capabilities

- none — schema generation and parity testing exist today but were never specced; this change backfills the capability and adds the documentation requirements.

## Impact

- `src/config/schema.ts` (descriptions and examples pass), `schema/woodhouse.schema.json` (regenerated), `TODO.md`'s schema-descriptions item is absorbed.
- No change to validation behavior: the schema/validator parity tests must stay green untouched.
