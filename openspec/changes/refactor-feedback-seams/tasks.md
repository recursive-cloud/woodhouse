# Tasks

## 1. One settings-path predicate (high-risk — settings-write trigger)

- [x] 1.1 Create `src/config/paths.ts` owning `LOCAL_PATHS`, `BASELINE_PATHS`
      and `isSettingsPath(path)` (exact match against the four settings-file
      paths); move the constants out of `src/config/resolver.ts` (re-imported
      from their new home) and make `src/settings/validate.ts`'s `isConfigPath`
      delegate to it. Verify with `test/paths.test.ts`: the four exact paths
      match; near-misses (`docs/woodhouse.yml`, `sub/.github/woodhouse.yml`,
      `woodhouse.yml.example`, `WOODHOUSE.yml`) do not.
- [x] 1.2 Adopt `isSettingsPath` in the push trigger in `src/app.ts`
      (replacing the `endsWith` match), and confirm no hand-rolled definition
      remains: grep for `endsWith("woodhouse` and for the path arrays finds
      them only in `src/config/paths.ts`. Verify `test/resolver.test.ts`,
      `test/validate.test.ts` and `test/config.test.ts` pass unmodified.
- [x] 1.3 Run `npm test && npm run typecheck` and confirm the whole suite is
      green.

## 2. Structural dry-run guard (high-risk)

A regression here makes DRY_RUN mode write to GitHub, so the group proves the
invariant structurally.

- [x] 2.1 Create `src/lib/dry-run.ts` exporting
      `performWrite(ctx: { dryRun: boolean; log: Logger }, label: string,
      run: () => Promise<T>): Promise<T | undefined>` — dry-run logs
      `DRY_RUN: would <label>` and skips `run`; otherwise it returns `run()`'s
      result. Verify with `test/dry-run.test.ts`: in dry-run the supplied
      fake is not called and the label is logged; on the live path the result
      passes through.
- [x] 2.2 Replace the ten inverted `if (!ctx.dryRun)` gates in
      `src/settings/apply.ts` with per-write `performWrite` calls, and the
      three composite early-return gates in `src/settings/validate.ts`,
      `src/gatekeeper/handler.ts` and `src/approval/silverPlatter.ts` with
      one `performWrite` around each composite write phase (same skip
      semantics, same log intent). Verify by grepping `dryRun` in `src/`:
      only the helper and the context plumbing remain — no hand-rolled gate.
- [x] 2.3 Run `npm test && npm run typecheck` and confirm the whole suite is
      green with the structural guard in place.

## 3. Shared pull facts

- [x] 3.1 Create `src/github/pulls.ts` exporting
      `listChangedFiles(octokit, owner, repo, pullNumber, { maxPages })`
      returning `{ files: { filename, status }[], truncated: boolean }` via
      `octokit.paginate`, and `getPullRequest(octokit, owner, repo,
      pullNumber)`. Verify with `test/pulls.test.ts` against a fake octokit:
      results across pages concatenate; owner, repo and number pass through
      unchanged; a `maxPages` cap sets `truncated` when more pages remain.
- [x] 3.2 Adopt both in `src/approval/silverPlatter.ts` (retiring the manual
      pagination loop, passing its current page cap, and feeding
      `truncated` into the approval request exactly as today) and
      `src/settings/validate.ts` (retiring its inline paginate call, staying
      unbounded as today). Verify `test/policy.test.ts` and
      `test/validate.test.ts` still pass, plus serve()-level
      characterization tests in `test/silver-platter.test.ts` on a fake
      octokit: an eligible untruncated listing is approved (review
      submitted, pinned to the head SHA), and a file list truncated at the
      cap is refused with no review submitted — exactly as today.
- [x] 3.3 Run `npm test && npm run typecheck`.

## 4. Shared marker comment manager

- [x] 4.1 Create `src/github/comments.ts` exporting
      `syncMarkerComment(deps, { owner, repo, issueNumber, marker, body })`:
      `body === undefined` ensures the comment is absent (delete if found); a
      defined body ensures it is present (create, or update in place). The
      manager guards its own writes through `performWrite` so every future
      caller gets dry-run safety structurally. Verify with
      `test/comments.test.ts` against a fake octokit: create when absent;
      update in place when present; delete when present and body undefined;
      no write when already in the desired state; in dry-run, zero octokit
      calls and a `DRY_RUN` log line.
- [x] 4.2 Make `src/settings/validate.ts`'s `syncComment` a thin call onto the
      manager, preserving exactly today's create/update/delete triad and the
      `<!-- woodhouse:config-validation -->` marker. Verify
      `test/validate.test.ts` passes unmodified.
- [x] 4.3 Run `npm test && npm run typecheck`.

## 5. Whole-change verification

- [x] 5.1 Run `mise run ci` (oxlint, oxfmt, typecheck, tests, build, schema
      drift check) and confirm `git diff --stat -- schema/` is empty — this
      refactor must not touch the generated JSON Schema.
