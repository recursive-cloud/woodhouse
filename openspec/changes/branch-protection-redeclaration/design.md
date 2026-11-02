# Design

## Context

`applyBranchProtection` (`src/settings/appliers/branch-protection.ts`) PUTs
protection for every branch listed under `branchProtection` on every sync and
emits a `branch-protection update` row per branch — deliberately, with the
fragility of GET-vs-PUT diffing documented in the code. `buildSettingsAppliedComment`
(`src/settings/mergeFeedback.ts`) only takes the no-op wording when the change
list is empty, so the two disagree: the spec promises a no-op report the
applier can never produce while any block is configured.

Issue #25's fork: (a) converge properly with GET/normalise/compare, or
(b) accept the re-declaration pattern the way rulesets already are and align
the spec. Decision: **(b)**.

## Goals / Non-Goals

- Goal: spec, schema prose, and TODO record the behaviour; nothing changes at
  runtime.
- Non-Goal: a GET-and-compare convergence pass; a `pruneBranchProtection`
  equivalent; any new delete path (none exists today, none is added).

## Decisions

### D1. Re-declaration, not convergence (the fork)

The applier's documented reasoning stands: branch protection's GET
representation differs structurally from the PUT payload (nested `enabled`
wrappers, expanded actor objects, API-required nulls), so a reliable diff is
error-prone for zero user-visible benefit — an idempotent write converges the
same state. Rulesets accept the same trade (GET normalisation), recorded in
TODO.md's "Accepted tradeoffs"; this change records branch protection there
too. The wording consequence is accepted: with any `branchProtection` block
configured, every sync reports the re-declared rows and the no-op wording is
unreachable while blocks remain configured.

### D2. Removal is stop-asserting, not delete

Removing a `branchProtection` block leaves any existing branch
protection in place indefinitely and silently; the sync returns to the no-op
wording while the orphaned protection keeps applying. A diffing applier would
not notice this either — it only knows the branches it is told about — so the
behaviour is common to both forks. Resolution is documentation, consistent
with the README's existing off-boarding stance ("Moving off branch
protection?"): GitHub ships a manual, assisted "Convert to ruleset" button
(one rule at a time, optional deletion of the original), and Woodhouse ships
no migration code. Wording caveat from review: the absence of a delete path
is a deliberate choice, not an API impossibility — GitHub offers DELETE
.../branches/{branch}/protection and lists branches by `protected`, so a
`pruneRulesets`-style opt-in would be mechanically possible; it is declined
because silently deleting protection Woodhouse did not create is
unacceptable. The schema prose states it; no state, no log line, no
code.

### D3. Everything else is untouched

`buildSettingsAppliedComment` takes the no-op wording only when the change
list is empty — under D1 that already means "no `branchProtection` blocks
configured AND nothing else needed changing", so the comment builder needs no
change. The applier needs no change. Only spec delta, TODO, schema prose, and
tests pinning the contracts.

## Risks / Trade-offs

- The silent remnant (D2) is real: an operator removing the block ships a
  comment saying nothing was needed while old protection still applies. Mitigating
  context: the README already instructs off-boarding through GitHub's
  converter, which deletes the original protection after conversion; the
  schema description will point there.
- Reporting "applied 1 change(s)" on a pure no-op is honest-but-noisy. Accepted:
  the row is truthful (an idempotent write did happen), re-declaration is the
  same pattern rulesets normalize to, and the alternative is either fragile
  diffing (rejected) or lying about the write (unacceptable).

## Migration Plan

None needed — no runtime behaviour changes; the merge is self-contained
documentation and schema-regeneration.

## Open Questions

None — the fork was decided by the owner ("after reading the code, (b) seems
the better option") after the removal-sequence question was answered by
reading `applyBranchProtection` and the README's converter pointer.
