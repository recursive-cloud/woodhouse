# Spec Delta

## Purpose

Woodhouse's own release process: versioned releases cut by release-please from conventional commits, container images tagged with release versions without rebuilding, and deployment manifests pinned to released versions.

## ADDED Requirements

### Requirement: Releases are cut by release-please from conventional commits
A release SHALL be produced by release-please from the conventional-commit titles of squash-merged pull requests on the default branch, as a running release pull request that accumulates changes and merges to cut the release. The bootstrap release SHALL be versioned 1.0.0.

#### Scenario: Feature merges accumulate
- **WHEN** a pull request titled `feat(...)​: ...` merges to main while a release pull request is open
- **THEN** the release pull request is updated with the change and its changelog entry

#### Scenario: Release pull request merges
- **WHEN** the release pull request merges
- **THEN** a version tag and GitHub release are created and the next release pull request is opened

### Requirement: Release workflows hold least privilege per job
The release-please job SHALL run with only `contents: write`; the image re-tag job SHALL run with only the registry access it needs (`packages: write`). No workflow triggered by pull requests SHALL hold write access to contents or packages.

#### Scenario: Pull-request runs stay read-only
- **WHEN** CI runs on a pull request
- **THEN** no workflow invoked by that pull request holds `contents: write` or `packages: write`

### Requirement: Images are tagged with release versions without rebuilding
On a published release, the container image built for the release commit SHALL be tagged with the release version (`vX.Y.Z`) and the floating major tag (`vX`) by re-tagging the existing image, not by building a new one.

#### Scenario: Release published
- **WHEN** a release is published
- **THEN** the image digest that the release commit's push build produced carries the `vX.Y.Z` and `vX` tags

### Requirement: Deployment manifests pin released versions
The compose file and the k8s kustomization SHALL reference a released version tag — not `latest` and not a bare commit SHA — and each release SHALL update both references.

#### Scenario: Release updates the pins
- **WHEN** a release is cut
- **THEN** `docker-compose.yml`'s image tag and `k8s/kustomization.yaml`'s `newTag` are updated to the released version in the release commit
