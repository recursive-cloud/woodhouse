# Tasks

## 1. Per-repo mutex + shared invalidation (high-risk — concurrency)

- [ ] 1.1 Add `test/mutex.test.ts` for `KeyedMutex` (concurrent `run()` calls
      on one key execute sequentially; different keys interleave), then wrap
      the push handler's `syncSettings` in the mutex keyed `${owner}/${repo}`
      in `src/app.ts`. Verify with `npm test`.
- [ ] 1.2 Extract the push handler's touched-config invalidation decision
      (owner-wide when the repository is the baseline) into a small shared
      helper next to the resolver, and adopt it in the push handler. Verify
      with unit tests on a fake resolver: baseline repository ->
      `invalidateOwner`, otherwise -> `invalidate`.
- [ ] 1.3 Run `npm test && npm run typecheck`.

## 2. Closed-handler detection

- [ ] 2.1 Add the merge-detection gate in `src/settings/mergeFeedback.ts` as
      a pure function over the merged flag, the base ref and the changed-file
      list (from the shared `listChangedFiles` + `isSettingsPath`): merged,
      base ref is the default branch, a settings path in any file status.
      Verify with focused unit tests: merged-only, default-branch-only,
      settings-touched in any status (added/modified/removed), near-miss
      file names rejected.
- [ ] 2.2 Run `npm test && npm run typecheck`.

## 3. Closed-handler wiring + serialization (high-risk — concurrency)

- [ ] 3.1 Wire the closed handler: `guarded.on("pull_request.closed",
      "settings-applied", ...)` in `src/app.ts` (forwarding only) onto
      `commentSettingsApplied` in `src/settings/mergeFeedback.ts` — detection
      from task 2.1, the same shared invalidation helper from task 1.2,
      resolve, `settings.enabled` check, `syncSettings` under the same
      per-repo mutex as the push handler. Verify with unit tests on a fake
      octokit and fake resolver: the full gate chain, silence when settings
      are disabled, and the sync running under the mutex key.
- [ ] 3.2 Add the race characterization: when the merge push and the closed
      event trigger a sync for the same repository nearly simultaneously,
      both run under the mutex in some order with no interleaved writes (a
      fake octokit records strictly sequential call sequences). Verify with
      `npm test`.
- [ ] 3.3 Run `npm test && npm run typecheck`.

## 4. The outcome comment

- [ ] 4.1 Add the pure comment builder (butler register per design D4:
      applied changes per area, failures with detail, nothing-further-needed
      variant, baseline variant, sign-off) with exact-string unit tests.
- [ ] 4.2 Wire the comment through the shared `syncMarkerComment` with the
      `<!-- woodhouse:settings-applied -->` marker. Verify with unit tests
      on a fake octokit: body always defined; a re-delivery updates the
      existing marker comment in place instead of creating a second one; in
      dry-run zero octokit calls happen and the body is logged.
- [ ] 4.3 Run `npm test && npm run typecheck`.

## 5. Docs + whole-change verification

- [ ] 5.1 Document the merged-settings feedback in `README.md` and add the
      merge-walk step to `docs/test-plan.md`. Verify `npm test` still passes
      (`test/config.test.ts`, `test/example-config.test.ts` — configuration
      docs stay consistent with the schema).
- [ ] 5.2 Run `mise run ci` (oxlint, oxfmt, typecheck, tests, build, schema
      drift check).
