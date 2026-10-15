# Design

## Context

CI today is a single workflow (`ci.yml`): `contents: read` globally, `packages: write` only inside the push-only image job; images tagged with the short SHA plus a raw `latest`; compose pins SHA `226df35` with a "bump deliberately" comment; the kustomization's `newTag` defaults to `latest` under a `REPLACE_ME` image name; `package.json` is `0.1.0`. Conventional PR titles are established practice here, and GitHub's squash-merge appends `(#N)` which release-please strips. History before `0755843` is prose — the first changelog has a gap, accepted.

## Goals / Non-Goals

**Goals:**

- A running release PR that *is* the 1.0 PR, accumulating the round's changes as they merge.
- Version-tagged images with the same digest as the tested push build — no rebuild on release.
- Deployment pins that release-please itself maintains, so no manual bump step exists to forget.

**Non-Goals:**

- Conventional-commit title enforcement (`woodhouse/dress-code`, post-1.0).
- Image signing, provenance attestations, SBOM (parked in TODO; `provenance: false` deliberately stays).
- Multi-package monorepo release config — one package at the repo root.

## Decisions

### D1: release-please in its own workflow, least privilege

New `.github/workflows/release.yml` with two jobs and per-job permissions:
the release-please job (`on: push` to main) runs
`googleapis/release-please-action@v4` with `permissions: contents: write`,
`issues: write`, `pull-requests: write` and the default `GITHUB_TOKEN` —
opening the release pull request needs `pull-requests: write`, and labeling
it `autorelease: pending` needs `issues: write`; the label is load-bearing
(release-please only recognizes its own PRs by it), and the action's own
README documents the set. The image re-tag job (chained from the
release-please job's outputs, design D3) holds `packages: write` only —
`docker buildx imagetools create` writes to the registry, not the repository. `ci.yml` is
untouched. Alternatives: folding
release-please into `ci.yml` (rejected — widens permissions onto every
pull-request run), manual releases (rejected — that is the status quo this
change exists to end).

### D2: bootstrap as 1.0.0 via `release-as`

`release-please-config.json` sets `"release-as": "1.0.0"` for the root
package; `.release-please-manifest.json` starts at the current `0.1.0`.
`"include-component-in-tag": false` keeps the tag `v1.0.0` rather than
`woodhouse-v1.0.0` (release-please otherwise prefixes the package name).
The first release PR is titled `chore(main): release 1.0.0` and accumulates the
round's work. After that release merges, a task removes `release-as` so
versioning resumes from commit types. Alternative: let the accumulated `feat`
commits propose `0.2.0` and hand-edit the PR title (rejected — the
accumulating PR should be the 1.0 PR without editing, and hand edits get
forgotten).

### D3: re-tag, don't rebuild, on release

A second job in `release.yml`, chained from the release-please job rather
than a `release: published` event — releases created with the default
`GITHUB_TOKEN` fire no workflow events, so an event-triggered job would
never run. It gates on the action's root-component `release_created` output
(`needs` + `if`) and reads `tag_name` and `sha` from the same outputs: GHCR
login, buildx, then `docker buildx imagetools create` tagging `vX.Y.Z` and
`vX` from the image already tagged with the release commit's short SHA. The release tag
points at the release PR's merge commit — the same commit whose push build
produced the SHA-tagged image, so the version tags land on the tested digest.
Alternatives: rebuild with `type=semver` metadata (rejected — double build and
a different, untested digest), skip version tags and deploy by SHA (rejected —
unreadable pins), a personal access token so `release: published` fires
(rejected — a standing new secret where the chained job needs none).

### D4: extra-files keep the deployment pins honest

This change switches `docker-compose.yml`'s image tag and
`k8s/kustomization.yaml`'s `newTag` to the bootstrap version, then registers
both files as `extra-files` (generic updater) so each release commit bumps
them. The generic updater is annotation-driven — each pinned image-tag line carries an inline `# x-release-please-version` comment marking it for the bump (the `v` prefix survives the version-only replacement), so the first bump is verified against the actual first release (see Risks for the fallback).
Deliberate window: from this change's merge until the 1.0.0 release merges,
the pins reference a tag that does not exist yet, so deployment pulls in that
window fail loudly rather than silently. The alternative — switching the pins
only in the post-release follow-up — was rejected because it hides the
switch from this change's review, and the extra-files registration needs
version strings in place either way.

### D5: `latest` keeps following main

The raw `latest` tag is unchanged: a moving convenience tag for the initial
test deployment. Release re-tagging does not touch `latest` — a release never
lags main, and re-pointing it would race the next push build for no gain.

## Risks / Trade-offs

- [Generic updater may not match the pin lines on the first release] → verify on the first release-please run; fallback is the documented one-line manual bump in the README runbook.
- [Conventional titles are unenforced until dress-code lands] → changelog quality rests on review discipline in the interim; the round's own PRs set the example.
- [Re-tag needs the release commit's push build to have finished] → the re-tag job runs in the same workflow run as the release-PR merge push, while `ci.yml`'s image job is still building; if the job races ahead of the image push, re-running the failed re-tag job alone is cheap and side-effect-free.
- [The release pull request itself runs no CI checks] → pull requests created with the default `GITHUB_TOKEN` do not trigger workflows; accepted, because the release PR's content is generated from commits that already passed CI on their own pull requests.

## Migration Plan

Merge this change → release-please opens the 1.0.0 release PR immediately →
the round's remaining changes accumulate into it → at round end the release PR
merges: tag, GitHub release, `v1.0.0`/`v1` image tags, manifest bumps → remove
`release-as` → later releases resume semver from commits alone.

## Open Questions

- None that change the approach; the generic-updater match on the first release is an apply-time observation with a documented fallback.
