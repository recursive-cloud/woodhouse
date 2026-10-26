# Woodhouse acceptance-run report

**Date:** 2026-10-18 → 2026-10-19
**Target:** `recursive-cloud/woodhouse` self-hosted GitHub App, image `ghcr.io/recursive-cloud/woodhouse` (started at `336c47d`, fixed and verified at `9ab881d`)
**Repos under test:** `recursive-cloud/woodhouse-test`, `recursive-cloud/.github-private` (baseline), `recursive-cloud/woodhouse-scratch` (+ `woodhouse-scratch-403`, created and consumed during the run)
**Plan:** `docs/test-plan.md`, phases 0–7, executed in order
**Outcome:** every phase executed; the deployment was restored to its recorded baseline (`DRY_RUN=false`, `LOG_LEVEL=info`, `ALLOWED_INSTALLATION_TARGETS='["recursive-cloud","gunzy83"]'`, image `9ab881d`) and is healthy and serving.

---

## Result matrix

| Phase | Result |
|---|---|
| **0 — onboarding** | **0.1–0.10 all PASS** |
| **1 — lockdown / resolution** | **1.1–1.7 all PASS** |
| **2 — white-glove (consolidated check)** | **2.1–2.13 all PASS** |
| **3 — auto-approval** | **3.1–3.9 all PASS** |
| **4 — config validation** | **4.1–4.5 all PASS** |
| **5 — settings sync** | **5.1–5.18 PASS; 5.19 & 5.20 contradict the plan** (below) |
| **6 — end to end** | **PASS** (after a corrected re-run — see *Process note*) |
| **7 — multi-App routing** | **7.1–7.6 all PASS** |

Per-test detail (expected → observed → evidence: log line + deliveryId, gh URL, check run) is kept with the run's records outside the repository.

---

## Bugs & findings for pre-1.0

### 1. Onboarding `getRef` uses the wrong ref form — **fixed in `9ab881d`, verified**
`src/onboarding/handler.ts` called `git.getRef({ ref: "refs/heads/<branch>" })`; GitHub's *Get a reference* endpoint requires `heads/<branch>`. Both call sites (default-branch probe ~:169, onboarding-branch existence probe ~:177) 404'd, so the onboarding walk failed with `Onboarding failed for <repo>: Not Found` before producing any offer. `write.ts` correctly uses the full form for `createRef`. The two-line fix shipped in `9ab881d` and was verified live (0.1, 0.6).

### 2. Operational hazard — switching an existing installation to *All repositories* triggers live offers
A fresh *All repositories* install correctly logs `Installation delivery carried no repository list; no onboarding offers were made` and walks nothing (0.9 PASS, plan-faithful). **But** flipping an *existing* installation's access to *All repositories* delivers an `installation_repositories` **added** event **enumerating** the newly-accessible repos — the app walked them all and, under `DRY_RUN=false`, opened **five real onboarding PRs** across the org (including on the real `woodhouse` repo). The source comment at `handler.ts:250` ("an all-repositories install does not enumerate pre-existing repositories") holds only for the fresh-install event, not the access-switch event. Cleaned up fully; worth an upstream warning or a guard.

### 3. 5.19 contradiction — branch protection is not convergent
The planner emits a `branch-protection update: <branch>` change and issues the PUT **unconditionally on every sync**, even when protection already matches. So with any `branchProtection` block present, a no-op merge never reaches the expected `The settings are in effect and nothing further needed changing` comment — it always reports an "applied" protection change. Fail-safe, but noisy. (5.19's wording *was* observed on `woodhouse-scratch` at 0.7, which has no `branchProtection` block — consistent with this root cause.)

### 4. 5.20 contradiction — baseline repo's own config is never read
For the baseline repo, the resolver probes only `.github/woodhouse.{yml,yaml}` (both 404) and never reads the root `woodhouse.yaml` as *its own* config — so the merged config resolves to defaults (`settings.enabled: false`). A merge on the baseline repo therefore hits `Settings management disabled; skipping sync` and the expected `This is the baseline repository, sir, so it has been synced directly…` comment is never posted. The cache invalidation (`Baseline configuration changed; cleared owner cache`) *does* fire correctly.

### 5. Smaller warts worth a look
- **Stale check-run status on pending:** a white-glove check that transitions completed→pending updates the title/summary but GitHub keeps the old `completed/failure` status, so the PR shows a red check wearing a "Waiting on…" title. Fail-safe, but visually odd.
- **Doubled rows on reopened PRs:** the seed workflow's `on: pull_request` (no `types:` filter) re-runs on `reopened`; the evaluator counts runs per suite, so each check name appears twice in the summary after a close/reopen.
- **Silent 200-drop of malformed signed events:** a correctly-signed event for a valid App whose payload Probot can't route returns `200 {"ok":true}` and vanishes — no log, no handler, no guard evaluation.
- **7.6 fatal names the App as `""`:** with `config/apps.cjs` keying Apps by the env var itself, an unset `APP_ID` yields the key `undefined`/`""`, so the fatal line reads `App "" has an invalid appId: undefined…` rather than a friendly label. Still actionable, and fail-closed.

### 6. Stale "known gap"
The plan's "nothing comments on the PR when config validation fails" is outdated — the app **does** post a `<!-- woodhouse:config-validation -->` marker comment on failure (4.2/4.3/4.4), with a clear body and security footnote.

---

## Operational / environment notes (not product bugs)
- **Org App permission-change wrinkle:** editing an org-owned App's permissions surfaces a "review this app" banner; a subsequent repository-add save is silently swallowed until the banner is accepted (0.10).
- **SSH `Repository … is disabled` transient:** GitHub-side, seen around visibility flips; resolves on retry within seconds. Use retry loops, not single attempts, around pushes during private↔public transitions.
- **stderr vs stdout:** fatal startup lines go to stderr; Docker log pulls must request `stderr=1` (a stdout-only pull misses them).

## Process note (Phase 6 first attempt)
The first Phase 6 run was invalid: my branch-protection PUT used `gh api -f` with a nested object, which GitHub rejected (`422`), so `woodhouse/white-glove` was never actually required — and a red `[fail-build]` PR merged. The merge was reverted (an empty commit) and the phase re-run with the requirement correctly applied via a raw JSON body; both halves then behaved per plan (happy PR mergeable, `[fail-build]` PR blocked with "the base branch policy prohibits the merge").
