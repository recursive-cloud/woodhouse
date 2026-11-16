# 0008. Release Process

Status: Accepted

## Context

Woodhouse ships as a container image and a self-hosted deployment. The version an operator runs must trace to a commit that passed CI, and the changelog must say what changed for them. Version bumps, tag creation and manifest edits done by hand drift and fail silently.

Release behaviour is not client-observable application behaviour. It runs in GitHub Actions, not in the webhook server, so Gherkin acceptance tests cannot observe a workflow tag or a manifest pin. The process therefore needs a written record here rather than scenarios under `features/`. This ADR supersedes `openspec/specs/releases/spec.md`; the openspec purge (REC-23) removes that spec, leaving this ADR as the record of the release process.

## Decision

Releases are cut by release-please, and each workflow job holds only the permissions it uses.

1. **release-please cuts releases from Conventional Commits.** Squash-merged pull request titles on `main` are the changelog source. release-please keeps a running release pull request; merging it cuts the release (version tag and GitHub release) and opens the next one. `googleapis/release-please-action@v4` runs in the `release-please` job of `.github/workflows/release.yml`. `release-please-config.json` sets `release-as: "1.0.0"` and `.release-please-manifest.json` holds `{"": "1.0.0"}`, so the bootstrap release is 1.0.0. The `release-as` key pins the version on every run until it is removed. Delete it after the 1.0.0 release pull request merges, so later releases derive from Conventional Commits again; release-please's own note says "once the release PR is merged you should either remove this or update it to a higher version".

2. **Each job declares only the permissions it uses.** The `release-please` job declares `contents: write` (the release commit, tag and release), `issues: write` (labeling the release pull request `autorelease: pending`) and `pull-requests: write` (opening and updating that pull request). The issue label is load-bearing: release-please recognises its own release pull requests by it, and a missed label would merge without a tag. The `retag-image` job holds only `packages: write` for the registry write through `docker buildx imagetools create`; it has no checkout and no contents access, and receives the release SHA and tag through job outputs. Permissions are scoped per job, not workflow-wide, so `retag-image` does not inherit the release grant. `.github/workflows/ci.yml` runs on pull requests with only `contents: read` at workflow level, so pull-request runs stay read-only.

3. **The release job authenticates with an App-minted token.** The `actions/create-github-app-token@v2` step exchanges `vars.RELEASE_APP_ID` (a repository variable, since an App ID is public) and `secrets.RELEASE_APP_PRIVATE_KEY` for a one-hour installation token scoped to `recursive-cloud/woodhouse`, and passes it as `token:` to the release-please action. Pull requests created with the default `GITHUB_TOKEN` do not trigger workflows, so a `GITHUB_TOKEN` release pull request would never run CI; an App-token pull request does. The App's repository permissions mirror release-please's grant (contents, pull requests and issues read/write, plus the bundled read-only Metadata) and nothing more, and the App has no webhook configuration. It exists only to mint CI tokens. Missing credentials or an App not installed on the repository fail the token exchange and the job. There is no fallback to `GITHUB_TOKEN`.

4. **The release image is re-tagged, not rebuilt.** `retag-image` chains on `needs: release-please` with `if: needs.release-please.outputs.release_created == 'true'`. Action outputs are strings, so the comparison is against the literal `'true'`; `'false'` is truthy in a GitHub expression. The job chains rather than triggering on `release: published` so the release outputs are already in hand. It copies the release commit's short-SHA image to the version tag (`vX.Y.Z`) and the floating major tag (`vX`) with `docker buildx imagetools create`, so every tag lands on the identical multi-arch manifest digest. `ci.yml` builds that source image with `type=sha,format=short,prefix=`, so the source ref is the first 7 characters of the release commit's full SHA. release-please cuts the release in seconds while `ci.yml`'s QEMU multi-arch build queues behind lint and test and then runs.

    The job therefore polls for the image first: 40 attempts 30 seconds apart, a bounded 20 minutes. Past that it fails loudly, most plausibly because `ci.yml`'s `cancel-in-progress` killed the build on a further push to `main`. The inspect sits inside an `if` because run steps default to `bash -e`, where a bare inspect would abort the step on the first missing tag.

5. **Deployment manifests pin the re-tagged image.** `docker-compose.yml`'s `image` tag and `k8s/kustomization.yaml`'s `newTag` name a released version tag (`v1.0.0` today), never `latest` and never a bare SHA. release-please rewrites both in the release commit through its `extra-files` generic entries and the `# x-release-please-version` marker on each line, so every release re-pins both references atomically.

## Consequences

- A squash-merged pull request title that breaks Conventional Commits produces a wrong or missing changelog entry, and may not bump the version as intended.
- If `release-as` stays in `release-please-config.json` past the bootstrap release, every release is forced back to 1.0.0 and no changelog-driven version bump happens. Removing the key after the first release pull request merges is part of cutting the bootstrap.
- The release GitHub App must be installed on the repository, with `RELEASE_APP_ID` set as an Actions variable and `RELEASE_APP_PRIVATE_KEY` as a secret. Without them every release fails at token exchange.
- App-token pull requests trigger CI, so the release pull request runs lint, test and build like any other pull request. The image job stays limited to pushes to `main`.
- A release whose image build failed or was cancelled waits the full 20 minutes and then fails. Recovery is re-running `ci.yml`'s image job and then the `retag-image` job, as the failure message and the `README.md` release runbook describe.
- The version tags carry the same digest as the short-SHA image that CI tested, so an operator can verify a release by comparing digests.
- `latest` keeps following `main`; releases never re-point it.
