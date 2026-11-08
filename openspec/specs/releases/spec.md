# releases Specification

## Purpose

Woodhouse's own release process: versioned releases cut by release-please from conventional commits, container images tagged with release versions without rebuilding, and deployment manifests pinned to released versions.

## Requirements

### Requirement: Releases are cut by release-please from conventional commits
A release SHALL be produced by release-please from the conventional-commit titles of squash-merged pull requests on the default branch, as a running release pull request that accumulates changes and merges to cut the release. The bootstrap release SHALL be versioned 1.0.0.

#### Scenario: Feature merges accumulate
- **WHEN** a pull request titled `feat(...): ...` merges to main while a release pull request is open
- **THEN** the release pull request is updated with the change and its changelog entry

#### Scenario: Release pull request merges
- **WHEN** the release pull request merges
- **THEN** a version tag and GitHub release are created and the next release pull request is opened

### Requirement: Release workflows hold least privilege per job
The release-please job SHALL declare only the write permissions it needs to open and label the running release pull request and cut the release (`contents: write`, `issues: write`, `pull-requests: write`); the image re-tag job SHALL run with only the registry access it needs (`packages: write`) and SHALL authenticate with the workflow's default `GITHUB_TOKEN`. No workflow triggered by pull requests SHALL hold write access to contents, issues, pull requests, or packages.

#### Scenario: Pull-request runs stay read-only
- **WHEN** CI runs on a pull request
- **THEN** no workflow invoked by that pull request holds `contents: write`, `issues: write`, `pull-requests: write`, or `packages: write`

### Requirement: Release automation authenticates as a GitHub App installation
release-please SHALL authenticate with an installation token minted from the repository's configured release GitHub App (App ID in the `RELEASE_APP_ID` variable, private key in the `RELEASE_APP_PRIVATE_KEY` secret) and scoped to this repository — not with the workflow's default `GITHUB_TOKEN`, whose events trigger no workflows. The App SHALL hold no permissions beyond release-please's grant and SHALL carry no webhook configuration: it exists only to mint installation tokens for CI.

#### Scenario: The release pull request triggers CI
- **WHEN** the release pull request is created or updated with the app token
- **THEN** the pull-request workflows run on it as on any other pull request

#### Scenario: The App holds nothing beyond release-please's grant
- **WHEN** the App's repository permissions are reviewed
- **THEN** they are exactly the release-please job's grant (metadata read-only bundled) and no other repository access

#### Scenario: Missing or unusable app credentials fail the job
- **WHEN** the release-please job runs without a usable app installation (credentials absent, or the App not installed on this repository)
- **THEN** the token exchange fails and the job fails rather than falling back to the default `GITHUB_TOKEN`

#### Scenario: App presence does not grant release identity beyond its permissions
- **WHEN** a change's release pull request or release commit would require a permission the App installation does not hold
- **THEN** the release job fails instead of silently performing the action with the workflow's wider (or other) credentials

### Requirement: Images are tagged with release versions without rebuilding
On a published release, the container image built for the release commit SHALL be tagged with the release version (`vX.Y.Z`) and the floating major tag (`vX`) by re-tagging the existing image, not by building a new one. The re-tag SHALL first wait — bounded — for the release commit's image to exist rather than fail while the push build is still running, and SHALL fail loudly when the wait times out.

#### Scenario: Release published
- **WHEN** a release is published
- **THEN** the image digest that the release commit's push build produced carries the `vX.Y.Z` and `vX` tags

#### Scenario: Release cut while the image build is still running
- **WHEN** the release cut completes while the release commit's push build is still building
- **THEN** the re-tag job waits for the image to appear and completes without a manual re-run

#### Scenario: The wait times out
- **WHEN** the release commit's image does not appear within the bound
- **THEN** the re-tag job fails with a message pointing at the runbook recovery

### Requirement: Deployment manifests pin released versions
The compose file and the k8s kustomization SHALL reference a released version tag — not `latest` and not a bare commit SHA — and each release SHALL update both references.

#### Scenario: Release updates the pins
- **WHEN** a release is cut
- **THEN** `docker-compose.yml`'s image tag and `k8s/kustomization.yaml`'s `newTag` are updated to the released version in the release commit
