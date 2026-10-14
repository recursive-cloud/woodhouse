# Tasks

## 1. release-please workflow and bootstrap config

- [ ] 1.1 Add `.github/workflows/release.yml` (release-please action, `on: push` to main, `permissions: contents: write`, default token). Verify with `npx oxfmt --check .` (oxfmt parses and format-checks YAML).
- [ ] 1.2 Add `release-please-config.json` (root package, changelog path, `"release-as": "1.0.0"`, `extra-files` for `docker-compose.yml` and `k8s/kustomization.yaml`) and `.release-please-manifest.json` (`".": "0.1.0"`). Verify both parse: `node -e "JSON.parse(require('fs').readFileSync('release-please-config.json','utf8')); JSON.parse(require('fs').readFileSync('.release-please-manifest.json','utf8'))"`.
- [ ] 1.3 Run `mise run ci` — lint, typecheck, tests, build, schema check all green with the new files in place.

## 2. Image version tags on release

- [ ] 2.1 Add a `release: published` job to `release.yml`: GHCR login, buildx setup, then `docker buildx imagetools create` tagging `vX.Y.Z` and `vX` from the release commit's short-SHA image tag. Verify the tag names derive from the release tag (`github.event.release.tag_name`) and `npx oxfmt --check .` passes.
- [ ] 2.2 Add a step summary listing the applied image tags. Verify with `npx oxfmt --check .` (and, if installed locally, `actionlint .github/workflows/release.yml` as an optional semantic check).

## 3. Deployment manifest pins

- [ ] 3.1 Switch `docker-compose.yml`'s image tag from the commit SHA and `k8s/kustomization.yaml`'s `newTag` from `latest` to the bootstrap version tag. Verify `npx oxfmt --check .` passes and the tag shape matches design D3/D4.
- [ ] 3.2 Document the release runbook in `README.md`: what merging the release PR does, how image version tags appear, and the manual-bump fallback if the extra-files update misses. Verify `npm test` still passes (configuration docs tests stay consistent).

## 4. Whole-change verification

- [ ] 4.1 Run `mise run ci && npm run schema:check` (the full gate — schema drift is not part of `mise run ci`).
- [ ] 4.2 After merge, observe the first release-please run open the 1.0.0 release pull request and record its URL in the change notes (apply-time observation; the runbook fallback in 3.2 covers a missed extra-files bump).

## Workflow follow-up

- Once the 1.0.0 release merges, remove `"release-as"` from `release-please-config.json` so subsequent versions derive from commit types.
