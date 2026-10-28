# Tasks

## 1. Resolver resolves the baseline repository's own root configuration

- [x] 1.1 In `ConfigResolver.load` (`src/config/resolver.ts`), select the local-layer paths as `BASELINE_PATHS` when `isBaselineRepo(repo)`, `LOCAL_PATHS` otherwise; update the module-header layer list and the self-merge comment above the baseline fetch.
- [x] 1.2 `test/resolver.test.ts`: baseline repo resolves its own root `woodhouse.yaml` as the local layer with settings enabled; no baseline layer fetched for the baseline repo (asserted via `sources`); custom `baselineRepo` behaves the same; root paths absent → defaults.
- [x] 1.3 `test/merge-feedback-handler.test.ts`: a merged settings PR on the baseline repository posts the baseline outcome comment and runs the sync (the issue #26 end-to-end path), instead of skipping with "Settings management disabled".

## 2. Verification

- [x] 2.1 `npm test` green; `npm run typecheck` clean; `mise run lint` clean.
- [x] 2.2 `openspec validate baseline-repo-self-config` passes.
