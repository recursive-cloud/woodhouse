# Design

Fork decision from issue #26: **(a) Narrow** — chosen by the user when the
issue was pulled in. Root `woodhouse.{yml,yaml}` become a valid local layer
only for the baseline repository. Broad (root files valid in every repo) was
rejected: it widens what counts as a settings file across validation and sync
gating.

## Section: Resolver local-layer path selection

`ConfigResolver.load` (`src/config/resolver.ts:L178-L226`) fetches two layers
in parallel: the baseline (skipped when the repo *is* the baseline) and the
local layer via `LOCAL_PATHS`. The change: the local fetch uses
`BASELINE_PATHS` when `this.isBaselineRepo(repo)`, `LOCAL_PATHS` otherwise.

```ts
const localPaths = this.isBaselineRepo(repo) ? BASELINE_PATHS : LOCAL_PATHS;
```

- `BASELINE_PATHS` and `LOCAL_PATHS` come from `src/config/paths.ts`, already
  imported by the resolver.
- The baseline layer's skip stays as-is; the comment above it ("Skipped
  entirely when the repo *is* the baseline, which would otherwise merge the
  file into itself") is updated to reflect that only the baseline *layer* is
  skipped — the repo's own root files now serve as its local layer.
- The module header's layer list gains a note that the baseline repository
  resolves its own root files as its local layer.
- `sources` naturally records the baseline repo's root file
  (`owner/.github-private:woodhouse.yaml`), matching what the acceptance run
  expected to see.

## Section: Why nothing else changes

- **Triggers and validation already work.** `BASELINE_PATHS` are part of the
  `SETTINGS_PATHS` set (`src/config/paths.ts`), and `isSettingsPath` gates the
  push handler in `src/app.ts`, the merge-feedback trigger in
  `src/settings/mergeFeedback.ts`, and `isConfigPath` in
  `src/settings/validate.ts`. A merge on the baseline repo already fires both
  handlers and invalidates the owner cache (acceptance run 5.20 proved this
  far) — resolution was the only broken link.
- **Cache invalidation is already correct.** For the baseline repo,
  `invalidateTouchedConfig` drops the whole owner cache, which covers the
  baseline repo's own cached entry in both of its roles (baseline layer for
  others, local layer for itself).
- **Onboarding asymmetry dissolves.** `CONFIG_PATHS` in
  `src/onboarding/handler.ts:L54` already includes the root baseline-shaped
  paths, so onboarding skips the baseline repository. After this change the
  resolver reads the same paths, so the two subsystems agree that the
  baseline repository manages itself through its root files.
- **`inherit: false` in the baseline repo's own root file** has no baseline
  layer to drop; the merge simply yields the local layer. No special case.

## Section: Tests

- `test/resolver.test.ts` ("ConfigResolver — baseline repository"):
  - the baseline repo resolves its own root `woodhouse.yaml` as the local
    layer with settings enabled;
  - no baseline layer is fetched for the baseline repo (existing
    "does not merge the baseline repo into itself" test, asserted via
    `sources`);
  - a custom `baselineRepo` behaves the same (parametrised where cheap);
  - root paths absent → defaults, as any other repo.
- `test/merge-feedback-handler.test.ts`: the end-to-end path from issue #26 —
  a merged settings PR on the baseline repository produces the baseline
  outcome comment and runs the sync, instead of the
  "Settings management disabled; skipping sync" dead end. Use the existing
  fake-resolver fixtures in that file; extend the fake to serve the
  baseline-repo resolution shape.
- Hermetic, following the existing `fetchLayer` fake-client patterns in
  `test/resolver.test.ts`.
