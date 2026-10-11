# Tasks

## 1. Config schema: owners and bots (high-risk — privilege config)

- [ ] 1.1 Change `autoApproval.allowedActors` in `src/config/schema.ts` to
      `z.object({ owners, bots })` — both string arrays `.default([])` with
      `.describe()`, the section keeping its `.prefault({})`; no union, no
      transform (the flat array is rejected). Verify in `test/config.test.ts`:
      the object form is accepted, both lists default to empty, the flat array
      is rejected, unknown keys are rejected.
- [ ] 1.2 Migrate `woodhouse.example.yml`: move `renovate[bot]` and
      `dependabot[bot]` from the flat list into `bots:` — a deliberate
      tightening (they become gated on their own auto-merge instead of
      approved unconditionally), noted in `README.md` in group 4. Regenerate
      `schema/woodhouse.schema.json` (`npm run schema:generate`); verify
      `test/json-schema.test.ts` passes (schema and runtime validator accept
      and reject the same documents) and `test/example-config.test.ts`
      accepts the migrated example.
- [ ] 1.3 Run `npm test && npm run typecheck`.

## 2. Decision logic (high-risk — privilege)

- [ ] 2.1 Add `autoMergeEnabledBy?: string | null` to `ApprovalRequest` and
      classify owners/bots in `decide()` (`src/approval/policy.ts`) per design
      D2-D3: owners approved subject to the existing checks; bots additionally
      require `autoMergeEnabledBy === author`; `undefined` neither vetoes
      the preliminary classification (an eligible bot proceeds to fact
      gathering) nor approves. Verify with the `test/policy.test.ts` matrix:
      owner/bot/neither across auto-merge `{undefined, null, other login,
      self}` plus protectedPaths, already-approved and case-insensitive
      matching.
- [ ] 2.2 Run `npm test && npm run typecheck`.

## 3. Fact gathering + tailored feedback (high-risk — enforcement)

- [ ] 3.1 Add `action` to `PullRequestFacts` and pass
      `context.payload.action` into `serve()` in `src/app.ts`; add the
      auto-merge fact gathering in `src/approval/silverPlatter.ts`: for a
      bots author, `await` the short constant grace only on `opened`, then
      read `auto_merge?.enabled_by?.login ?? null` through the shared
      `getPullRequest`; owners skip the fetch. Verify with unit tests using a
      fake octokit: the GET fires only for bots-listed authors, the delay
      applies only on `opened`, `null` when auto-merge is absent, and a bot
      author is not declined by the preliminary pass (the fetch happens
      before the full decision).
- [ ] 3.2 Add the pure per-class review-body builder (exact strings per
      design D5, both ending with the sign-off) with unit tests on the
      strings, and wire it into `serve()`'s submission — still pinned to the
      head SHA, still idempotent, dry-run logs without submitting.
- [ ] 3.3 Run `npm test && npm run typecheck`.

## 4. Docs + whole-change verification

- [ ] 4.1 Document the new shape in `README.md`, note the hand migration, and
      check off the `TODO.md` item. Verify the documented example still
      parses via `test/example-config.test.ts`.
- [ ] 4.2 Run `mise run ci` (oxlint, oxfmt, typecheck, tests, build, schema
      drift check).
