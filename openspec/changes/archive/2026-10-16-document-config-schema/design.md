# Design

## Context

Only two `.describe()` calls exist today (both on `allowedActors` sub-lists); the rest of the schema's prose lives in TSDoc block comments that `z.toJSONSchema` does not carry. Sections are wrapped in `.prefault({})` (zod 4: a prefault is fed through the schema so field defaults apply), and zod 4 offers `.describe()` and `.meta({ description, examples })`. `harden-ruleset-support` lands before this change, so the descriptions document the final shape: typed `ref_name` conditions, synced bypass enums, honest prune semantics, and the open `rules` core with its rationale. The parity test (schema vs runtime validator over the same corpus) and the CI drift check already exist and stay untouched.

## Goals / Non-Goals

**Goals:**

- Hover documentation for every field and examples for the fiddliest three areas, with zero change to validation behavior.
- The two TODO-named unknowns answered and recorded: `title` emission from `.meta()`, and description survival across `.prefault({})` wrappers.

**Non-Goals:**

- No modeline offer for new config files — that belongs to the onboarding pull request, which writes new files.
- No schema restructuring beyond what description survival requires; no new fields, no validation changes.
- No exhaustive example for every field — examples target `strictChecks`, `protectedPaths`, and `rulesets`.

## Decisions

### D1: `.describe()` per field, `.meta()` where more is needed

`.describe()` remains the idiomatic per-field description carrier; `.meta({ examples })` adds examples where a description alone is thin. Whether `.meta({ title })` also emits `title` in `z.toJSONSchema` output is observed during the probe task and recorded in the change notes — cosmetic either way, so it does not gate the approach.

### D2: probe before the full pass

A small test first: one prefault-wrapped section with a described field, through `z.toJSONSchema`, asserting the description appears. If descriptions do not survive the wrapper, the probe task restructures (attach the description to the inner schema before wrapping, or describe after wrapping) and the pattern from the probe becomes the rule for the full pass. This answers the TODO's second open question with code rather than conjecture.

### D3: pass order and the ruleset prose

The pass proceeds gatekeeper → autoApproval → settings → repository → branchProtection → labels → rulesets → root. The rulesets description is the largest single piece: it lists the supported rule types as prose (maintained by hand when GitHub adds types — deliberately not an enum, per `harden-ruleset-support`'s open-core decision), shows the `ref_name` condition shape, the bypass actor shape, and warns what prune does. Example values are strings that parse as the field's YAML/JSON shape.

### D4: prose moves, it does not duplicate

TSDoc that duplicates a `.describe()` string rots twice as fast: where the comment and the description would say the same thing, the description becomes the single source and the comment shrinks to what a code reader needs (rationale, history) that a config author does not.

## Risks / Trade-offs

- [Descriptions rot as fields evolve] → the drift check regenerates on every schema change, so stale prose surfaces in the same diff that changed the field.
- [The probe could force an awkward restructuring] → confined to one pattern decision made once in the probe task, then applied mechanically.
- [Example values could drift from real shapes] → the parity corpus and the example-config test are the guardrails; examples are also validated by the runtime in the same test run where cheap.

## Migration Plan

Regenerate and commit the schema; editors pick up the documentation on next file open. No runtime migration.

## Open Questions

- None that change the approach; `title` emission is recorded, not depended on.
