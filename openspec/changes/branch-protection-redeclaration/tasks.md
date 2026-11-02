# Tasks

The MODIFIED deltas in `specs/settings-sync/spec.md` are applied to `openspec/specs/settings-sync/spec.md` by the archive step, not by implementation tasks — mirror of `retag-wait-for-image`, whose spec application also rides on archive.

## 1. Record the tradeoff and the schema prose

- [x] 1.1 `TODO.md` "Accepted tradeoffs": add an entry next to the rulesets one — branch protection converges by unconditional re-declaration, reported as applied on every sync (mirrors the rulesets entry). Second sentence: removing a block ends the re-assertion and does NOT delete the protection behind it — off-boarding is GitHub's assisted "Convert to ruleset" flow (`README.md` "Moving off branch protection?").
- [x] 1.2 `src/config/schema.ts` (`branchProtectionSchema`): add a truthfulness description on the block — re-declared (idempotent PUT) on every sync and reported as applied even when already matching; removing the block ends the re-assertion and does not delete existing protection; off-board via GitHub's converter. Regenerate `schema/woodhouse.schema.json` and commit.

## 2. Tests pinning the contracts

- [x] 2.1 `test/merge-feedback.test.ts`: the no-op wording appears only when no `branchProtection` blocks are configured; with a block present the comment lists the re-declared `branch-protection update` row(s) instead.
- [x] 2.2 `test/appliers/branch-protection.test.ts`: confirm a test asserts the change row is emitted on every sync; add one only if none does.

## 3. Verification

- [x] 3.1 `openspec validate branch-protection-redeclaration` passes.
- [x] 3.2 `npm test` green; `npm run typecheck` clean; `npx oxfmt --check` on touched files; `npm run schema:generate` produces no additional diff.
