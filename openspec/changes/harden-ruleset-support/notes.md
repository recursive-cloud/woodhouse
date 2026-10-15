# Notes

## Task 1.1 — bypass enums and condition keys, re-verified against the live REST reference (2026-10-15)

Re-verified against https://docs.github.com/en/rest/repos/rules (researcher pass;
org-level cross-check at https://docs.github.com/en/rest/orgs/rules). No deltas of
substance versus the October 2026 research pass behind the design; one nuance and one
unverifiable date, recorded below.

Confirmed lists, repository-level rulesets:

- **`bypass_actors[].bypass_mode`** — exactly three values: `always`, `pull_request`,
  `exempt` (default `always`). `exempt` means the rules are not run for that actor and
  no bypass audit entry is created; it is documented in the REST reference only (the
  web UI exposes just "Always allow" / "For pull requests only"). The "~2025-09
  addition" date from the earlier pass could not be verified (no changelog entry
  found) — the value itself is current and confirmed.
- **`bypass_actors[].actor_type`** — exactly six values: `Integration`,
  `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey`, `User` (PascalCase).
  `actor_id` is required for Integration / RepositoryRole / Team / User, ignored for
  `OrganizationAdmin`, must be null for `DeployKey`. Enterprise-level rulesets add
  `EnterpriseOwner` and `EnterpriseRole` — enterprise-only, deliberately **not** added
  to this repo-level enum.
- **repository-level `conditions` keys** — exactly one: `ref_name` →
  `{ include: string[], exclude: string[] }`, supporting `~DEFAULT_BRANCH` / `~ALL`.
  Organization-only keys confirmed present: `repository_name`, `repository_id`,
  `repository_property`.

Versus the code at apply start, the enum sync (task 1.2) adds exactly `User` to
`actor_type` and `exempt` to `bypass_mode`; the five existing actor types
(`Integration`, `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey`) and both
existing bypass modes (`always`, `pull_request`) are confirmed current — matching the
researcher's October 2026 findings, no delta.

### Rules-array `type` list (input to the `rules` TSDoc, task 1.2)

Current REST rules-array `type` names (the list, verbatim from the reference — the
researcher's headline said "24", the listed names number 25; the names, not the
count, are what the TSDoc cites):

`creation`, `update`, `deletion`, `required_linear_history`, `merge_queue`,
`required_deployments`, `required_signatures`, `pull_request`,
`required_status_checks`, `non_fast_forward`, `commit_message_pattern`,
`commit_author_email_pattern`, `committer_email_pattern`, `branch_name_pattern`,
`tag_name_pattern`, `workflows`, `code_scanning`, `code_quality`, `code_coverage`,
`copilot_code_review`, `license_compliance_scanning`, `file_path_restriction`,
`max_file_path_length`, `file_extension_restriction`, `max_file_size`.

Notes: all five of the design's "recently grown" types are in the current REST list
(`workflows` is the required-workflows rule). `secret_scanning` appears in the UI
"Available rules" page but not in the REST rules array — confirming the design's
doc-vs-API mismatch warning and the decision to keep `rules` open. Older
names like `pull_request_lines`, `commit_message_non_matching_status`,
`merge_queue_non_blocking_status`, `tag`, `file_path` are GraphQL/legacy names, not
current REST.

### Rule parameter names (input to the task-2.1/2.2 fixtures)

The design's parenthetical "(contexts, strict flag)" is branch-protection-API
shorthand; the current REST rule parameters for the two fixture types are:

- `required_status_checks.parameters`: `required_status_checks` — array of
  `{ context, integration_id? }`; `strict_required_status_checks_policy` (required
  boolean — not `strict`); `do_not_enforce_on_create` (optional boolean).
- `pull_request.parameters`: `required_approving_review_count`,
  `dismiss_stale_reviews_on_push`, `require_code_owner_review`,
  `require_last_push_approval`, `required_review_thread_resolution`,
  `dismissal_restriction`, `allowed_merge_methods` (plus beta `required_reviewers`).

The fixtures use these real names — passthrough fidelity is the point, and GitHub
validates rule bodies on write. Citations:
https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset

## Whole-change verification (2026-10-15)

First verification pass (reviewer-pro, openspec-verify-change): **APPROVE** —
no critical issues, no warnings. Gates re-run independently: `npm test`
(30 files, 394 tests), `npm run typecheck`, `npm run schema:check`, `mise run
ci`, `openspec validate harden-ruleset-support` — all green. Requirements-to-
tests traced for all four requirements (1 modified + 3 added); design D1–D6
reflected; non-goals respected; the TSDoc rule-type list matched this file
name-by-name. Three suggestions, resolved or recorded:

1. **Org-only-condition test weaker than the scenario** (asserted only
   `path.includes("conditions")`) — resolved: the test now pins the exact
   issue path `rulesets.0.conditions` and asserts the message names
   `repository_name` (empirically confirmed: zod v4 `.strict()` reports the
   object's path with the unrecognized key in the message — a path ending in
   the key itself is not behavior zod produces, so pinning the exact path +
   key-in-message is the strongest true assertion).
2. **`conditions: { ref_name: {} }` (neither list) validates** — recorded as
   a deliberate non-change: the spec delta says only "any OTHER condition key
   SHALL be a validation error"; design D1 makes `include`/`exclude` optional
   on purpose (the spec's own scenario is include-only). Tightening to
   require at least one non-empty list would reject beyond the delta —
   follow-up material if wanted, not part of this change.
3. **Proposal Impact list omitted `README.md`** — resolved: the list now
   names it (the pointer was task 3.2's own deliverable; bookkeeping gap,
   not scope creep).

A second, independent verification pass (reviewer-local, a different tier
from the first per the change's high-risk group-1 rule) also returned
**APPROVE**, verifying from scratch: gates re-run green, all four
requirements traced to regression-failing tests, non-goals respected,
cross-artifact coherence confirmed. Its one suggestion — that the README
pointer's UI specifics (the "Convert to ruleset" button, one rule at a
time, optional delete-original) were not gate-verified — is closed by this
session's researcher pass against the live docs (fetched 2026-10-15): the
conversion lives under Settings → Branches as "Convert to ruleset", works
one branch protection rule at a time with a preview, and offers an optional
"Delete branch protection rule once migration is done" tick
(https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/converting-branch-protections-to-rulesets).
