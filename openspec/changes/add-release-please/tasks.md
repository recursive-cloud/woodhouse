# Tasks

## 1. release-please workflow and bootstrap config

- [x] 1.1 Add `.github/workflows/release.yml` (release-please action, `on: push` to main, `permissions: contents: write`, `issues: write`, `pull-requests: write` — the set the action needs to open and label the release PR — default token). Verify with `npx oxfmt --check .` (oxfmt parses and format-checks YAML).
- [x] 1.2 Add `release-please-config.json` (root package, changelog path, `"release-as": "1.0.0"`, `extra-files` for `docker-compose.yml` and `k8s/kustomization.yaml`) and `.release-please-manifest.json` (`".": "0.1.0"`). Verify both parse: `node -e "JSON.parse(require('fs').readFileSync('release-please-config.json','utf8')); JSON.parse(require('fs').readFileSync('.release-please-manifest.json','utf8'))"`.
- [x] 1.3 Run `mise run ci` — lint, typecheck, tests, build, schema check all green with the new files in place.

## 2. Image version tags on release

- [x] 2.1 Add the image re-tag job to `release.yml`, chained from the release-please job (`needs` + `if` on the action's `release_created` output — releases cut with the default `GITHUB_TOKEN` never fire `release: published` workflows): GHCR login, buildx setup, then `docker buildx imagetools create` tagging `vX.Y.Z` and `vX` from the release commit's short-SHA image tag (`tag_name` and `sha` from the action outputs). Verify the tag names derive from the action's `tag_name` output and `npx oxfmt --check .` passes.
- [x] 2.2 Add a step summary listing the applied image tags. Verify with `npx oxfmt --check .` (and, if installed locally, `actionlint .github/workflows/release.yml` as an optional semantic check).

## 3. Deployment manifest pins

- [x] 3.1 Switch `docker-compose.yml`'s image tag from the commit SHA and `k8s/kustomization.yaml`'s `newTag` from `latest` to the bootstrap version tag. Verify `npx oxfmt --check .` passes and the tag shape matches design D3/D4.
- [x] 3.2 Document the release runbook in `README.md`: what merging the release PR does, how image version tags appear, and the manual-bump fallback if the extra-files update misses. Verify `npm test` still passes (configuration docs tests stay consistent).

## 4. Whole-change verification

- [x] 4.1 Run `mise run ci && npm run schema:check` (the full gate — schema drift is not part of `mise run ci`).
- [ ] 4.2 After merge, observe the first release-please run open the 1.0.0 release pull request and record its URL in the change notes (apply-time observation; the runbook fallback in 3.2 covers a missed extra-files bump).

## Workflow follow-up

- Once the 1.0.0 release merges, remove `"release-as"` from `release-please-config.json` so subsequent versions derive from commit types.
