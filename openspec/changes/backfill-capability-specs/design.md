# Design

## Context

The spec inventory covers `settings-sync` and `auto-approval` only. The four surfaces this change backfills are implemented, tested, and battle-tested: the gatekeeper's decision logic is a pure function over check runs with the bulk of the test suite; config validation reuses the marker-comment seam; lockdown and multi-App operation are enforced in `src/security/` and `src/server.ts`/`src/apps/registry.ts` with startup-refusal semantics throughout. This is a documentation-shaped change: specs are extracted from behavior, not the reverse.

## Goals / Non-Goals

**Goals:**

- Four capability specs whose requirements state observable behavior and whose scenarios map to existing tests or documented behavior wherever such a mapping exists.
- Gaps (a scenario with no test, a behavior only visible in comments) recorded as notes in the change directory — follow-up material, not silent smoothing, and not fixed here.

**Non-Goals:**

- No code, test, or configuration changes.
- No spec for config resolution and cascading (defaults → owner baseline → repo local, objects merge / arrays replace). It is stable, `settings-sync` references it, and backfilling it would balloon the change; a later change can spec it deliberately.
- No re-speccing or reorganizing of `settings-sync` and `auto-approval`; no new capability grouping (the project uses a flat `specs/` layout and this follows it).

## Decisions

### D1: Capability boundaries

Four capabilities, cut along module seams that also match how the surfaces fail independently: `gatekeeper` (verdict + check lifecycle), `config-validation` (the `woodhouse/config` check + comment), `installation-lockdown` (allowlist + owner resolution + startup refusals), `multi-app-operation` (registry + routing + delivery outcomes). The guard's "all handlers register through the guard" rule is expressed as lockdown's before-any-handler requirement rather than a rule about code structure, because that is the observable consequence. The `woodhouse/config` check's own behavior belongs to config-validation; its aggregation into the white-glove verdict belongs to gatekeeper and is stated there.

### D2: Behavior-extracted method

Each requirement is written from the implementation and its tests (the pure decision modules are the primary source; `schema.ts` TSDoc and `docs/` are secondary). Where a behavior is verified only by a comment or the docs walk rather than a test, the scenario still states it, and the mapping note in the change directory records which is which. Nothing is specced that the code does not do.

### D3: Granularity follows the settings-sync precedent

Four to six requirements per capability, each with two to four scenarios — the density of the existing `settings-sync` spec, not an exhaustive catalog. Restart-related tradeoffs (grace-period timers not surviving restarts) stay in TODO's accepted-tradeoffs section rather than becoming requirements.

### D4: Cross-capability references stay loose

Where one capability consumes another (white-glove aggregating the `woodhouse/config` check; onboarding later riding config-validation), specs reference behavior by name, not by requirement ID, so later deltas can evolve one side without rewriting the other.

## Risks / Trade-offs

- [Specs could drift from code the day after they land] → the round's feature changes intentionally delta against these baselines immediately (onboarding touches config-validation), so drift is caught by review rather than accumulating.
- [Writing specs may tempt code "fixes"] → explicitly out of scope; anything found becomes a follow-up note.
- [A scenario without a test is a claim without a guard] → mapping notes record which scenarios lack coverage, turning them into future test backlog.

## Migration Plan

None — documentation only; `mise run ci` must stay green untouched, which is itself the verification that nothing behavioral changed.
