# Owners and bots in auto-approval

Split the auto-approval actor list into **owners** and **bots**, and approve a
bot's pull request only when *that bot* enabled auto-merge. Owners are approved
unconditionally. Closes the "Before 1.0" TODO item.

## Problem

Today `autoApproval.allowedActors` is one flat list of logins, compared
case-insensitively in `decide()`. There is no distinction between a human owner
and a bot or service account: `renovate[bot]` and a person are treated
identically, and the review body is one static string for all of them.

Two consequences:

- The butler approves *every* PR from a listed bot, even ones the bot is not
  asking to merge.
- The review comment cannot be tailored to who actually opened the PR.

## Design

### Config

`autoApproval.allowedActors` becomes an object with two lists:

```yaml
autoApproval:
  enabled: true
  allowedActors:
    owners:
      - gunzy83          # approved unconditionally (subject to protectedPaths)
    bots:
      - renovate[bot]    # approved only when it enabled auto-merge itself
      - dependabot[bot]
  protectedPaths:
    - .github/woodhouse.yml
    - .github/woodhouse.yaml
```

- `owners` — approved unconditionally, subject to `protectedPaths`.
- `bots` — the strict class: approved only when the actor enabled auto-merge
  *themselves*. Any login may appear here; the rule is "enabled auto-merge,"
  not "is literally a `[bot]`-suffixed account."

The app is pre-release, so the legacy flat array is **not** carried forward —
existing configs are migrated by hand. No union, no transform: the field is
simply `z.object({ owners, bots })`, both `.default([])`, `.strict()`, with the
section's existing `.prefault({})`.

### Decision logic (`src/approval/policy.ts`)

`decide()` classifies the author by list membership (not `pr.user.type`):

- in `owners` → approve (subject to the existing checks).
- in `bots` → additionally require `autoMergeEnabledBy === author`.
- in neither → refuse, as today.

`protectedPaths` remains the inviolable hard veto against privilege escalation
(a bot auto-merging a PR that widens the actor lists). The auto-merge gate
*adds* a condition for bots; it never replaces that one.

`ApprovalRequest` gains `autoMergeEnabledBy?: string | null`:

- `undefined` — the fact has not been gathered yet (preliminary pass); the bot
  gate is skipped so the cheap pre-check can still classify the author.
- `null` — gathered, nobody has enabled auto-merge.
- a string — gathered, this login enabled it.

### Trigger (`src/approval/silverPlatter.ts`, `src/app.ts`)

There is no dedicated auto-merge webhook, and the `auto_merge` field in the
`pull_request` payload is a stale snapshot (Renovate toggles auto-merge a
moment *after* opening). So for a **bots** author, on each of the four events
the app:

1. waits a short grace period (a constant, a couple of seconds, only on the
   `opened` action), then
2. `GET`s the pull request and reads `auto_merge?.enabled_by?.login ?? null`.

The result is folded into the request facts and the bot gate in `decide()`
applies. Owners skip this entirely. `PullRequestFacts` gains the `action` so
`serve()` knows when to apply the delay.

### Review body

Tailored per class, keeping the butler register:

- Owner: *"Very good, sir. Approving on your behalf — this pull request touches
  no protected paths."*
- Bot: *"Sir, just letting you know I am letting the handyman in to fix a few
  things — `{author}` asked to be merged and this pull request touches no
  protected paths."*

Both end with the existing `_Woodhouse, at your service._` sign-off.

## Files

| File | Change |
|---|---|
| `src/config/schema.ts` | `allowedActors` → `{ owners, bots }` object; `.describe()` on both sub-lists. |
| `src/approval/policy.ts` | `ApprovalRequest.autoMergeEnabledBy`; `decide()` classifies owners/bots and gates bots on auto-merge. |
| `src/approval/silverPlatter.ts` | `getAutoMergeEnabledBy()` (delay + GET); gather the fact in `serve()`; tailored body; `PullRequestFacts.action`. |
| `src/app.ts` | pass `action: context.payload.action` into `serve()`. |
| `schema/woodhouse.schema.json` | regenerate (CI drift check + `json-schema.test.ts`). |
| `test/policy.test.ts` | owner/bot/auto-merge matrix. |
| `test/config.test.ts`, `test/json-schema.test.ts` | the object form. |
| `woodhouse.example.yml` | migrate to the new shape. |
| `README.md`, `TODO.md` | document + check off the item. |

## Net behavior

- **Owner PR** → approved (protectedPaths veto only). No auto-merge needed.
- **Bot PR** → approved iff it set its own auto-merge, no protected path, not
  truncated, not already approved.
- **Late-toggle race** (bot opens, sets auto-merge after, no further event) →
  the `opened` pass declines; caught on the next `synchronize` /
  `ready_for_review` / `reopened`. Fail-safe: it never wrongly approves.
