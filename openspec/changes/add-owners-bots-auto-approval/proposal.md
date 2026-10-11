# Proposal

## Why

`autoApproval.allowedActors` is one flat list of logins: a human owner and
`renovate[bot]` are treated identically, so Woodhouse approves every pull
request from a listed bot even ones the bot is not asking to merge, and the
review comment cannot be tailored to who opened it. The full design for the
split already exists and was agreed (`docs/owners-bots-auto-approval.md`);
this change implements it — the "Distinguish owners from 'the help'" item
from Before 1.0 in `TODO.md`.

## What Changes

- **BREAKING** (pre-release; configs migrate by hand):
  `autoApproval.allowedActors` becomes `{ owners: [], bots: [] }`, both
  defaulting to empty; the legacy flat array is rejected, not transformed.
- Owners: approved unconditionally, subject to `protectedPaths` and the
  shared guards. Bots: approved only when that bot enabled auto-merge itself.
- Classification is by list membership (case-insensitive), never by account
  type — any login may sit in `bots`; the rule is "enabled auto-merge", not
  "has a `[bot]` suffix".
- For a bots author, the auto-merge fact is gathered at decision time (the
  webhook payload's `auto_merge` field is a stale snapshot — Renovate toggles
  it a moment after opening): a short constant delay on the `opened` action,
  then a pull-request GET reading `auto_merge?.enabled_by?.login ?? null`.
  Owners skip the fetch entirely.
- Review bodies are tailored per class in the butler register, ending with
  the existing sign-off.
- Fail-safe: a bot that toggles auto-merge after opening is caught on its
  next event; the gate never wrongly approves.

## Capabilities

### New Capabilities

- `auto-approval`: automatic pull-request approval by actor class —
  owner/bot classification, the bot auto-merge gate, the protected-path
  veto, per-commit idempotency, trigger events and draft handling, tailored
  feedback, strict config validation, and dry-run safety.

### Modified Capabilities

- none — the project has no specs yet; existing approval behavior is
  captured as part of the new `auto-approval` capability's requirements.

## Impact

- `src/config/schema.ts` (owners/bots object + `.describe()` on both
  sub-lists); `schema/woodhouse.schema.json` regenerated (CI drift check).
- `src/approval/policy.ts` (`ApprovalRequest.autoMergeEnabledBy`;
  `decide()` classification and bot gate), `src/approval/silverPlatter.ts`
  (auto-merge fact gathering with the opened-action delay; tailored bodies;
  `PullRequestFacts.action`), `src/app.ts` (passes the action into `serve()`).
- Tests: `test/policy.test.ts` (owner/bot/auto-merge matrix),
  `test/config.test.ts`, `test/json-schema.test.ts`;
  `woodhouse.example.yml` migrates to the new shape; `README.md` and
  `TODO.md` updated.
- Rides on `refactor-feedback-seams` (`getPullRequest` in the shared
  pull-facts module).
