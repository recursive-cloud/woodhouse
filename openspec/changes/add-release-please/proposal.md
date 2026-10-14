# Proposal

## Why

Woodhouse ships an image per commit but has no releases: no version numbers, no changelog, and deployment pins that reference either a frozen commit (`docker-compose.yml` pins `226df35`) or a moving target (`k8s/kustomization.yaml` defaults `newTag: latest`). The 1.0 milestone needs a versioned, changelogged release process — and cutting it first means the round's remaining changes land as conventional commits that visibly accumulate in the 1.0 release PR while it is being built.

## What Changes

- release-please manages versions and the changelog: a new `release.yml` workflow (its own minimal permissions, `contents: write`) opens and maintains a running release pull request on main, derived from conventional-commit PR titles — which this repo already follows.
- Bootstrap targets **1.0.0** (`release-as`), so the accumulating release PR literally is the 1.0 release PR. The pre-conventional history (before `0755843`) is accepted as a gap in the first changelog.
- Published releases tag the GHCR image: a `release: published` job re-tags the already-built SHA image with `vX.Y.Z` and the floating `vX` via `docker buildx imagetools` — no rebuild, identical digest to the tested push build.
- Deployment manifests stop drifting: `docker-compose.yml` and `k8s/kustomization.yaml` move to version tags, registered as release-please extra-files so every release commit bumps both.
- Conventional-commit PR-title *enforcement* is deliberately not here — `woodhouse/dress-code` (post-1.0) is the planned enforcement; until then titles are convention-only.

## Capabilities

### New Capabilities

- `releases`: how Woodhouse itself is versioned and released — release pull requests cut from conventional commits, semver-tagged images without rebuilds, and version-pinned deployment manifests.

### Modified Capabilities

- none

## Impact

- New: `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`.
- Edited: `docker-compose.yml` (image tag → version), `k8s/kustomization.yaml` (`newTag` → version), `README.md` (release runbook).
- Untouched: `ci.yml` (permissions stay `contents: read`; push-build image tags stay SHA + `latest`), all runtime code.
- `package.json`'s version becomes release-please-managed from the first release.
