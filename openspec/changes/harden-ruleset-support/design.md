# Design

## Context

The current shape: `rulesetSchema` (src/config/schema.ts) types `name`, `target`, `enforcement`, and `bypass_actors`, while `conditions` is an open record and `rules` an open `{type, ...passthrough}` array — the openness of `rules` is deliberate and documented ("GitHub validates the rest on write"). The planner matches rulesets case-insensitively by name, creates unknown names, always re-PUTs known names (GitHub's GET normalises bodies, so a reliable diff is impossible), and prunes every unmatched ruleset when `settings.pruneRulesets` is on — with a schema comment claiming "managed by us" that no code enforces. No test constructs a rule. Against the live API (REST repos/rules, October 2026): repository rulesets support exactly one condition key, `ref_name.include/exclude`; bypass modes are `always`, `pull_request`, `exempt` (added 2025-09); the actor-type list adds `User` beyond the current enum (`DeployKey` is already present). GitHub also shipped auto-migration from branch protection to rulesets (Aug 2026), which retires the "no migration path" gap as a code concern — it becomes a docs pointer.

## Goals / Non-Goals

**Goals:**

- Type the stable perimeter (`conditions`, bypass enums, uniqueness); keep the moving core (`rules`) open.
- Make prune and re-PUT semantics truthful in comments, example config, and spec.
- Prove the passthrough pipeline with realistic rule fixtures end to end.

**Non-Goals:**

- No full rule-type modelling — the API grew five rule types in ~18 months (`code_quality`, `code_coverage`, `copilot_code_review`, `license_compliance_scanning`, required workflows); a zod union would rot and reject valid new rule types.
- No `strictChecks` derivation from ruleset required checks (post-1.0), no actor-ID lookup by team/role/login (descriptions only), no read-back verification of applied ruleset content, no branch-protection→ruleset migration code (GitHub's converter is the answer).

## Decisions

### D1: `conditions` typed strict to `ref_name`

`z.object({ ref_name: z.object({ include: z.array(z.string().trim().min(1)), exclude: z.array(z.string().trim().min(1)) }).strict().optional() }).strict().optional()`. Rationale: repository rulesets support only `ref_name`; organization-only keys (`repository_name`, `repository_id`, `repository_property`) were always going to 422 at write time on this endpoint. The alternative — keeping the open record — defers the typo feedback to a GitHub 422 inside a sync, far from the author. Fails-closed here means failing *earlier*, not rejecting more.

### D2: bypass enums synced, verified against the live reference

Add `User` to `actor_type` and `exempt` to `bypass_mode`, matching the REST reference. Because the research pass flagged doc-vs-API mismatches in this area (a `secret_scanning` rule listed in UI docs but not the REST array; `evaluate` shown as Enterprise-gated), the apply includes a task to re-verify the enums against the current REST reference before regenerating the schema, adjusting if the reference disagrees.

### D3: duplicate names rejected at the config level

A `superRefine` on the top-level `rulesets` array rejecting case-insensitive duplicate names, because the planner matches case-insensitively — `main` and `MAIN` would silently target the same ruleset. Config-level (not per-ruleset) because the conflict is between entries.

### D4: prune honesty

Rewrite the `pruneRulesets` comment and description: opt-in converge-everything — deletes every ruleset not named in the configuration, including hand-made ones; no ownership marker exists because GitHub's ruleset API offers no metadata slot for one. The example config gains a realistic ruleset (required status checks + pull request reviews, `~DEFAULT_BRANCH` conditions) with a comment warning what prune does. Alternative considered — prune only Woodhouse-created rulesets (e.g. a name prefix) — rejected as magic that silently diverges from "the config is the truth".

### D5: realistic fixtures proving passthrough fidelity

Plan and applier tests with a full ruleset: `required_status_checks` (contexts, strict flag), `pull_request` (approving count, dismiss-stale), `ref_name` conditions, and a bypass actor — asserting the PUT/POST body preserves every parameter verbatim. The pipeline is generic, so one rich fixture per layer (plan, apply) covers the passthrough risk; a matrix of rule types would test GitHub, not Woodhouse.

### D6: spec amendment instead of no-op detection

Keep always-PUT; amend the settings-sync requirement to state the exception (already in this change's delta). Alternative — skip the PUT when a GET of the ruleset matches the plan — rejected: GitHub's GET response is normalised (ids, counts, server-side defaults) and a reliable comparison would need a body-normaliser that itself drifts.

## Risks / Trade-offs

- [Narrowing `conditions` rejects locally-valid configs] → those configs were write-time 422s waiting to happen; the failure moves to authoring time with a path in the message. Hand-migration per pre-release precedent.
- [Enum sync could over-accept if the reference has drifted again] → apply-time re-verification task (D2) gates the regenerated schema.
- [Prune's converge semantics can destroy hand-made rulesets] → opt-in default-off, truthful wording, example warning; the risk was always there, only the comment was wrong.

## Migration Plan

Regenerate and commit the schema; hand-fix any live config that trips the new validation (none expected — the example and live configs don't use conditions or duplicate names).

## Open Questions

- None that change the approach. The exact `z.toJSONSchema` rendering of the typed conditions (nested object vs flattened) is observed at regeneration, not decided here.
