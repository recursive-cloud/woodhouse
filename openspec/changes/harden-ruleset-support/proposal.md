# Proposal

## Why

Rulesets are GitHub's modern enforcement surface and Woodhouse's transport for them is solid — plan, apply, prune, and 403 UX all work — but the edges are thin: `conditions` accepts any record although repository rulesets support exactly one condition key; the bypass enums have drifted from the API (`exempt` mode and the `User` actor type are missing); duplicate ruleset names silently collide in the name-keyed plan; `pruneRulesets` deletes hand-made rulesets while its own comment claims "managed by us"; not one test constructs a real rule; and the spec's "writes nothing when already matching" wording does not match the unconditional re-PUT that rulesets actually perform.

## What Changes

- **Typed edges, open core.** `conditions` becomes a strict `ref_name: { include, exclude }` object — the only condition repository rulesets support. `bypass_actors` enums sync to the current API (`User` actor type; `exempt` bypass mode — re-verified against the live REST reference during apply). `rules` stays an open passthrough (GitHub validates rule bodies on write) but its schema description will list the supported rule types.
- **Duplicate names rejected.** Two rulesets sharing a name (case-insensitive — names are the plan's match key) fail validation at authoring time.
- **Prune made honest.** The "managed by us" comment is replaced with the truth: opt-in converge-everything semantics that delete any ruleset absent from the configuration, hand-made or not. The example config carries a realistic ruleset and the prune warning.
- **Real fixtures.** Plan and applier tests construct real rule types (`required_status_checks`, `pull_request`) with parameters, `ref_name` conditions, and a bypass actor, proving passthrough fidelity end to end.
- **Spec honesty.** The settings-sync "writes nothing when already matching" requirement is amended: rulesets converge by idempotent re-PUT because GitHub's ruleset reads are normalised and cannot be diffed against the planned body.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `settings-sync`: the default-branch push requirement is amended to state the ruleset re-declaration exception; requirements are added for typed ruleset conditions, unique ruleset names, and truthful prune semantics.

## Impact

- `src/config/schema.ts` (conditions typing, bypass enum sync, duplicate-name refinement, updated comments), `src/settings/plan.ts` (logic unchanged — typing flows through), `woodhouse.example.yml` (realistic ruleset example + prune warning), `schema/woodhouse.schema.json` (regenerated), tests in `test/` (validation, plan, appliers).
- No behavior change for valid existing configurations: a config using `ref_name` conditions validates as before; a config using any other condition key was going to be rejected by GitHub at write time (422) and now fails earlier, at the author.
- Configurations are hand-migrated as needed (pre-release precedent from the owners/bots split).
