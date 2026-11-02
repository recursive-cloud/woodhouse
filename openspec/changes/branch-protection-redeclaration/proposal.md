# Proposal

## Why

Branch protection never converges to a no-op report. With any
`branchProtection` block configured, every settings sync — even a pure no-op —
PUTs protection for each configured branch and emits a `branch-protection
update` change row, so the settings-applied comment always claims changes were
applied and the spec's no-op wording ("The settings are in effect and nothing
further needed changing") is unreachable. Observed exactly once (acceptance run
2.5, issue #25) on a repository without a `branchProtection` block — consistent
with this root cause.

## What Changes

- Fork decision (issue #25): **Accept the re-declaration pattern.** Branch
  protection converges by unconditional re-declaration, exactly like rulesets
  already do: the sync re-PUTs protection for every configured branch each
  pass and reports a `branch-protection update` row per branch. The GET
  representation of branch protection is structurally different from the PUT
  payload (nested `enabled` wrappers, expanded actor objects), so diffing is
  more error-prone than an idempotent write — the applier at
  `src/settings/appliers/branch-protection.ts` documents this reasoning, and
  the code already behaves this way; this change makes the spec and wording
  agree with the behaviour. Alternative (converge via GET-and-compare) is
  rejected as fragile per the applier's own analysis.
- The no-op wording of the outcome comment applies only when the merged
  configuration has no `branchProtection` blocks configured and nothing else
  needed changing.
- Removing a `branchProtection` block from the configuration stops the
  re-assertion but does NOT delete the existing branch protection — there is
  no delete path and no prune equivalent for branch protection, by design.
  Off-boarding is manual via GitHub's assisted branch-protection → rulesets
  converter, already documented in `README.md`. This behaviour is now stated
  in the configuration schema so it is not rediscovered as a bug.

## Capabilities

### Modified Capabilities

- `settings-sync` — the default-branch-push requirement gains branch
  protection alongside rulesets as the thing re-declared rather than
  diff-skipped; the outcome-comment requirement's no-op wording is scoped to
  repositories without configured branch protection; a new requirement states
  that removing a block does not remove protection.

## Impact

- `openspec/specs/settings-sync/spec.md` — two requirements restated to match
  the behaviour; one requirement added (`prune`-style delete path explicitly
  absent).
- `TODO.md` — new "Accepted tradeoffs" entry next to the rulesets one, so the
  pattern is not rediscovered as a bug.
- `src/config/schema.ts` (`branchProtectionSchema`) — truthfulness prose on
  the block: re-declared each sync; removing the block ends the re-assertion
  but leaves the protection behind; off-board via GitHub's converter.
  Regenerate `schema/woodhouse.schema.json` and commit.
- `test/merge-feedback.test.ts` — pin the no-op wording contract: only when
  zero `branchProtection` blocks are configured. `test/appliers/branch-protection.test.ts`
  — confirm the change row is emitted on every sync, already matching.
- No behaviour change: `applyBranchProtection` and
  `buildSettingsAppliedComment` are untouched.
