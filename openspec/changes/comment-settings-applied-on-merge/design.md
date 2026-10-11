# Design

## Context

Today settings sync triggers only on push to the default branch (`app.ts`:
ref check, deleted check, touched-config detection via the shared predicate,
cache invalidation — owner-wide when the repo is the baseline repository —
resolve, enabled check, `syncSettings`). After `refactor-apply-pipeline`,
`syncSettings` returns an `ApplySummary` that reaches only the log. There is
no `pull_request.closed` listener today, and nothing links a default-branch
push back to its pull request; delivery order between the merge `push` and
`pull_request.closed` is not guaranteed. The linkage decision (agreed): use
the `pull_request.closed` (merged) event itself — it carries the pull request
number and works for every merge strategy. Parsing `(#N)` from merge-commit
messages (breaks on rebase merges and custom messages) and search-by-SHA
(index lag) were considered and rejected.

## Goals / Non-Goals

**Goals:**

- An outcome comment on the merged settings pull request, working for every
  merge strategy, never duplicated, serialized with the push trigger, honest
  about what applied, what failed, and what needed nothing.
- Dry-run safety with no new gates to remember (structural, from the seam
  changes this rides on).

**Non-Goals:**

- No fan-out re-sync of every owner repository on a baseline change —
  today's semantics are kept (repositories adopt at their next event); a
  future change could add fan-out deliberately.
- No comment for direct pushes (no pull request to comment on).
- No wiring-framework restructure of `app.ts` — the new listener follows the
  existing `guarded.on` shape; full normalization stays deferred to the
  onboarding change.

## Decisions

### D1: trigger and gates

New listener `guarded.on("pull_request.closed", "settings-applied")`, cheap
gates first: `merged === true`; `base.ref` is the default branch (settings
only live from the default branch — a pull request merged into a feature
branch has not changed live settings); the changed-file list (shared
`listChangedFiles`) contains a settings path in **any** status — added,
modified or removed, because deleting the local layer is a settings change
too; the resolved config has `settings.enabled`. Any miss returns silently.
The handler logic lives in a new `src/settings/mergeFeedback.ts`
(`commentSettingsApplied(deps, scope, pr)`); `app.ts` only registers and
forwards, matching the handler-module pattern. The detection gates are a
pure function over the merged flag, the refs and the changed-file list, so
they are testable without octokit.

### D2: cache honesty before resolving

The closed handler invalidates the repository's cache entry *before*
resolving — owner-wide (`invalidateOwner`) when the repository is the
baseline repository, exactly like the push handler's rule. The push
handler's invalidation decision is extracted into a small shared helper both
handlers call, so "which invalidation a settings change implies" is declared
once. Rationale: delivery order between `closed` and `push` is not
guaranteed, so the resolver must not serve a stale entry.

### D3: apply under a per-repo mutex

Both triggers wrap `syncSettings` in the `KeyedMutex` keyed
`${owner}/${repo}` — repo-scoped, unlike the gatekeeper's `owner/repo@sha`,
because the two triggers of one merge concern the same repository, not a
commit. Plans diff against current state, so the second pass is a safe
idempotent retry of whatever the first left behind; the comment reflects the
final state. The push handler adopting the mutex is behavior-preserving
hardening (it is a single writer today).

### D4: the comment

Marker `<!-- woodhouse:settings-applied -->` through the shared
`syncMarkerComment`, body always defined (this is a one-time outcome report,
upserted in place on re-delivery). The body comes from a pure builder fed
the `ApplySummary` and a baseline flag, in the butler register: applied
changes per area; failures with their detail; "nothing further needed
changing" when the summary is empty (for example when the merge push already
applied everything); the baseline variant states the baseline was synced and
that other repositories adopt the change at their next event. Exact strings
live in the pure builder with unit tests, ending with the established
sign-off.

### D5: dry-run is structural

`syncSettings` guards its own writes (via the seam changes) and the
commenter guards its own; the handler has no new gate to remember — it logs
the would-be comment body.

### D6: silence when settings management is disabled

If the resolved config has `settings.enabled === false` — including a pull
request that just disabled management — no sync and no comment; log instead.

## Risks / Trade-offs

- [The push pass may apply first, leaving an empty summary] -> the "nothing
  further needed changing" wording is honest, and the empty pass also
  retries whatever a failed push pass left behind.
- [Baseline semantics may surprise] -> truthful variant comment; fan-out
  deliberately out of scope.
- [app.ts grows one listener] -> same shape as the existing seven; the
  deferred wiring normalization stays deferred.
- [A second sync per merge] -> idempotent plan-diff, serialized by the
  mutex; negligible cost.

## Migration Plan

Deploy; merge a settings pull request on a real repository and observe the
comment per the `docs/test-plan.md` walk.
