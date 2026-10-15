# Design

## Context

The re-tag job in `release.yml` chains from the release-please job (`needs` + `if: release_created == 'true'`), holds `packages: write` only, needs no checkout, and re-tags the release commit's short-SHA image to `vX.Y.Z`/`vX` with two `imagetools create` invocations. On the same merge push, `ci.yml`'s image job queues behind lint+test then runs a QEMU multi-arch build: on PR #11's merge push, build+test took 18s and the image job 39s — the image lands about a minute after the push on a warm run — while release-please cuts the release in seconds. The race is documented (README runbook: re-run the failed job; verified: re-runs preserve needs-outputs and the create is idempotent) with this wait named as the minimal self-healing fix. See proposal.md — Why.

## Goals / Non-Goals

**Goals:**

- Hands-off release cuts: no manual re-run in the normal path.
- Keep the job's shape: one job, `packages: write` only, no checkout, same chaining and outputs.
- Loud, bounded failure with the existing runbook recovery on the edges.

**Non-Goals:**

- Serializing the two workflows (workflow_run machinery; the payload carries no release info).
- Event or PAT triggers — rejected in add-release-please's design D3, and they do not serialize anything anyway.
- Changes to permissions, chaining, outputs, or the create invocations.

## Decisions

### D1: poll the source ref, inside the job
After buildx setup and before the two create steps, a wait step polls `docker buildx imagetools inspect` on the resolved source ref every 30 seconds, up to 20 minutes (40 attempts), then exits 1 with a message pointing at the runbook recovery. The inspect sits in an `if`/`while` condition — run steps default to `bash -e`, so a bare sequenced inspect would abort the step on the first not-yet-existing tag and silently reintroduce the race; guarded, a missing tag is a normal poll outcome. Each attempt logs `attempt i/40`, so a long wait is visible in the job log and the first real cold-cache run measures the bound's margin. buildx pushes platform manifests untagged and creates the tag only when the final manifest list lands, so the tag appearing means the push completed — never a partial push (verified locally: inspect on the real `76e0bbb` image succeeds; a bogus tag fails — the exact failure mode the poll keys on). Polling inside the job keeps one job and one permission set, and re-runs are free: when the image already exists (the old recovery path, or CI finishing early) the first inspect succeeds immediately.

Alternatives: workflow_run chaining (more machinery, and the event payload carries no release context to gate on); retrying the create step itself on failure (indistinguishable from real create failures — muddier diagnosis; a pre-flight wait has one clear failure mode); an unbounded wait (holds the runner indefinitely; the bound keeps the documented failure as the fallback).

### D2: 30-second interval, 20-minute bound
Observed warm-run duration is about a minute (18s build+test + 39s image on PR #11's merge push); cold-cache QEMU multi-arch builds and queue delays stretch that to minutes. 20 minutes covers the slow case with wide margin; exceeding it means something is actually wrong — most plausibly the `cancel-in-progress` edge, where a further push to main has killed the release merge's CI build. Failing there is exactly right: the runbook recovery (re-run CI's image job first, then this job) is unchanged, just delayed by the bound.

### D3: comments and runbook tell the same story
The workflow's "may still be running / re-running this failed job is cheap" comments and the README runbook's re-tag bullet are rewritten: the normal path is that the job waits and completes; the edges (timeout, cancelled build) fall back to the runbook recovery. The old "expect it to fail on the release cut" wording described the pre-wait design and goes.

## Risks / Trade-offs

- [A hosted runner is held for the wait, up to 20 minutes] → the wait ends the moment the image lands (about a minute warm); the cadence is one release cut, and ubuntu-latest minutes are cheap for it.
- [The poll could see a tag whose push is incomplete] → buildx creates the tag only with the final manifest list, so the tag cannot exist before the multi-arch push completes.
- [A timeout masks the real cause] → the timeout message names the likely causes and the recovery steps; CI's own failure or cancellation is visible independently in its run.

## Migration Plan

One small change to `release.yml` and the README runbook — no code, schema, permissions, or release-please config changes. Lands as a conventional commit and accumulates into the open 1.0.0 release PR (#12) before it merges. Ordering: add-release-please must archive before this change archives — its archive creates `openspec/specs/releases/`; until then the archive step refuses this change's MODIFIED delta (validate passes now, noting the constraint as an INFO).

## Open Questions

- None — the bound is a tunable number with evidence behind it, and the fallback is the already-documented recovery.
