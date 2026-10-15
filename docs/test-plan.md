# Test plan

A first pass at exercising Woodhouse against real repositories, ordered so the
reversible things are proven before the destructive ones are switched on.

## Repositories

| Repo | Visibility | Purpose |
| --- | --- | --- |
| `recursive-cloud/.github-private` | private | owner-wide baseline config |
| `recursive-cloud/woodhouse-test` | private | the repository under test |

Both must be included in the App installation, or the baseline cannot be read.

## Before you start

1. Install the App on **`recursive-cloud` only**, selecting just those two
   repositories.
2. Run with `DRY_RUN=true`. Every decision is evaluated and logged; nothing is
   written back to GitHub. The plan says when it flips: Phase 0 step 0.2, Phase 2
   after 2.1, Phase 3 onwards.
3. Tail the logs. Every entry carries `owner`, `repo`, `deliveryId` and
   `handler`, so `deliveryId` ties a log line back to a specific delivery in
   the App's *Advanced* tab.

---

## Seed configuration

### `.github-private` → `woodhouse.yml`

```yaml
# Owner-wide baseline for recursive-cloud.

settings:
  enabled: false        # phase 3 turns this on
  pruneLabels: false
  pruneRulesets: false

repository:
  has_issues: true
  has_wiki: false
  has_projects: false
  allow_squash_merge: true
  allow_merge_commit: false
  allow_rebase_merge: false
  delete_branch_on_merge: true

labels:
  - name: bug
    color: d73a4a
    description: Something is not working
  - name: dependencies
    color: 0366d6

gatekeeper:
  enabled: true
  strictChecks: []
  ignoredChecks: []

autoApproval:
  enabled: true
  allowedActors:
    owners:
      - gunzy83
```

### `woodhouse-test` → `.github/woodhouse.yml`

Deliberately minimal, to prove the cascade is doing the work:

```yaml
repository:
  has_issues: false     # overrides the baseline's `true`

gatekeeper:
  ignoredChecks:
    - advisory
```

Expected merge result: `has_wiki: false` and the label list inherited from the
baseline, `has_issues: false` from the local override, `allowedActors:
{owners: [gunzy83]}` inherited, and `ignoredChecks: [advisory]` local.

### `woodhouse-test` → `.github/workflows/ci.yml`

A controllable CI suite. Every outcome the gatekeeper cares about can be driven
from the PR title, so a single repo covers the whole truth table:

```yaml
name: CI
on:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: build
        run: |
          if [[ "${{ github.event.pull_request.title }}" == *"[fail-build]"* ]]; then
            echo "failing on request"; exit 1
          fi
          echo ok

  test:
    runs-on: ubuntu-latest
    steps:
      - name: test
        run: |
          if [[ "${{ github.event.pull_request.title }}" == *"[fail-test]"* ]]; then
            echo "failing on request"; exit 1
          fi
          echo ok

  slow:
    # Hold the suite in progress long enough to observe a pending gatekeeper.
    runs-on: ubuntu-latest
    steps:
      - run: |
          if [[ "${{ github.event.pull_request.title }}" == *"[slow]"* ]]; then
            sleep 120
          fi
          echo ok

  optional:
    # Skipped unless requested, producing a `skipped` conclusion.
    if: contains(github.event.pull_request.title, '[run-optional]')
    runs-on: ubuntu-latest
    steps:
      - run: echo ok

  advisory:
    # Always fails, and is in ignoredChecks, so must not affect the verdict.
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: exit 1
```

---

## Phase 0 — onboarding on install (`DRY_RUN=true`, then off)

The installation walk is the first thing to observe and the most reversible — it
only ever opens a pull request you can close. Do it on a **scratch repository**
that is empty of a settings file (the default new-repo "Add a README" checkbox is
fine — a default branch with no settings file is the target state). A repository
with no default branch instead produces the expected `has no default branch` error
trace rather than an offer: that is the fail-closed edge, not this phase's target.
The two repositories above are already configured, so they are skipped by design —
the same skip reason as check 0.8.

Phase 0 expects `LOG_LEVEL=debug`. The four settings-path probes surface through
Probot's request logging and the `Onboarding skipped` lines are `debug` entries,
so at the documented default (`info`) the product looks dead while behaving
correctly. The `DRY_RUN: would …` lines, the summary line and the 403 hint all
appear at `info`/`error` regardless.

Create the scratch repository and add it to the existing installation —
installation settings → *Repository access* → add it. That fires
`installation_repositories.added`; installing the App on it fresh fires
`installation.created`. Either path runs the same walk.

| # | Test | Action | Expected |
| --- | --- | --- | --- |
| 0.1 | Dry run shows the offer | Add the scratch repo with `DRY_RUN=true` | Logs show the four settings-path probes (each 404), then `DRY_RUN: would create branch woodhouse/onboarding`, `DRY_RUN: would commit .github/woodhouse.yml to woodhouse/onboarding` and `DRY_RUN: would open pull request "chore: onboard to Woodhouse"`, then one summary line carrying `branch`, `file`, `title` and `body`. **Verify GitHub shows no branch, commit or pull request** |
| 0.2 | The offer is made | `DRY_RUN=false`, then re-fire the event (remove and re-add the repo, or redeliver from the App's *Advanced* tab) | PR `chore: onboard to Woodhouse` from `woodhouse/onboarding` adds `.github/woodhouse.yml` (`settings.enabled: true`, schema modeline) and carries the `woodhouse: onboarding` label |
| 0.3 | The offer is validated by the product | Watch the PR's checks | `woodhouse/config` **passes** on the added file and `woodhouse/white-glove` goes green — the product validates its own onboarding pull request |
| 0.4 | Nothing else runs | Watch the logs while the PR is open | No settings sync for the scratch repository; white-glove and config validation are the only activity |
| 0.5 | Re-delivery is idempotent | Redeliver the installation event from the App's *Advanced* tab | No second branch, commit or pull request; one debug line `Onboarding skipped`, `reason: onboarding-pull-request-open` |
| 0.6 | Closed without merging re-offers | Close the PR without merging, then re-fire the event | The existing `woodhouse/onboarding` branch is reused as-is (not rewritten) and a fresh PR opens from it |
| 0.7 | Merging is the opt-in | Merge the onboarding PR | Settings sync runs for the scratch repository and leaves the outcome comment on the PR; management is on from then on |
| 0.8 | Already-configured skip | Re-fire the event with the settings file now on the default branch | Silent skip — one debug line `Onboarding skipped`, `reason: settings-file-present`. This is also why the two repositories above never get an offer |
| 0.9 | All-repositories caveat | (Optional) Install the App with *All repositories* | One log line: `Installation delivery carried no repository list; no onboarding offers were made`. Re-add a repository or reinstall with selected repositories |
| 0.10 | Restricted installation | Temporarily remove the installation's `Contents`/`Pull requests` write access and re-fire | The 403 hint log names both the read permissions and `contents: write`/`pull_requests: write`; the walk continues. Restore access — it takes effect on the next installation event |

## Phase 1 — lockdown and config resolution (`DRY_RUN=true`)

| # | Test | Action | Expected |
| --- | --- | --- | --- |
| 1.1 | App starts | Deploy with the allowlist set | Log: `Woodhouse reporting for duty` with `allowedInstallationTargets` and `baselineRepo: .github-private` |
| 1.2 | Fail-closed startup | Restart with `ALLOWED_INSTALLATION_TARGETS` unset | Container exits **78**, single fatal JSON line. Restore afterwards |
| 1.3 | Wildcard refused | Set it to `["*"]` | Exits 78 with a wildcard message |
| 1.4 | Non-allowlisted owner | Temporarily set the allowlist to `["nobody"]`, push to `woodhouse-test` | Log `decision: rejected`, `reason: not-allowlisted`, and **no GitHub API calls** follow. Restore |
| 1.5 | Cascade resolves | Open any PR | Log line `Resolved woodhouse configuration` with `sources` listing **both** files, baseline first |
| 1.6 | Baseline not self-merged | Push to `.github-private` | `sources` is empty for that repo — it does not merge into itself |
| 1.7 | Cache invalidation | Push a config change to `.github-private` | Log `Baseline configuration changed; cleared owner cache` |

## Phase 2 — the white-glove check (`DRY_RUN=true`, then off)

Turn `DRY_RUN=false` once 2.1 logs the right verdict, so the check actually
appears. **Do not** make it a required check yet.

| # | Test | PR title | Expected `woodhouse/white-glove` |
| --- | --- | --- | --- |
| 2.1 | All pass | `test: happy path` | success — "All N checks passing" |
| 2.2 | Appears early | any | Check exists as *pending* from PR open, before CI finishes |
| 2.3 | A check fails | `test: [fail-build]` | failure, summary names `build` |
| 2.4 | Two fail | `test: [fail-build] [fail-test]` | failure listing **both**, not just the first |
| 2.5 | Still running | `test: [slow]` | pending while `slow` runs, then success |
| 2.5a | No false green at open | `test: happy path`, watch from the instant the PR opens | Check is **pending** ("Waiting for checks to start") before Actions registers, never success. This was a real bug: it concluded success on the empty check set |
| 2.5b | Grace period expiry | Open a PR in a repo with no workflows at all | pending for `gatekeeper.gracePeriodSeconds` (default 30), then success — no deadlock |
| 2.6 | Failure beats pending | `test: [slow] [fail-build]` | failure immediately — does not wait for `slow` |
| 2.7 | Skipped ignored | `test: happy path` | `optional` is skipped; verdict still success |
| 2.8 | Skipped counted when strict | Add `optional` to `strictChecks` in the baseline, reopen | failure — "listed in gatekeeper.strictChecks" |
| 2.9 | Missing strict check | Set `strictChecks: [nonexistent]` | pending forever, "has not reported". **The important one** |
| 2.10 | Ignored check fails harmlessly | `advisory` always fails | verdict unaffected (it is in `ignoredChecks`) |
| 2.11 | No self-loop | watch logs after the check writes | No repeated re-evaluation; it ignores its own completion |
| 2.12 | Re-run | *Re-run all jobs* in the Checks tab | Check updates rather than duplicating |
| 2.13 | New commit | Push to the PR branch | Re-evaluated against the new SHA |

Reset `strictChecks` to `[]` afterwards.

## Phase 3 — auto-approval (`DRY_RUN=false`)

| # | Test | Action | Expected |
| --- | --- | --- | --- |
| 3.1 | Trusted author | Open a PR as `gunzy83` touching `README.md` | Approving review from `woodhouse[bot]` |
| 3.2 | Draft refused | Open as draft | No approval; log `pull request is a draft` |
| 3.3 | Ready for review | Mark the draft ready | **Approved** — `ready_for_review` is now handled |
| 3.4 | **Protected path** | PR editing `.github/woodhouse.yml` | **No approval**, log `modifies protected path`. The privilege-escalation guard |
| 3.5 | Untrusted author | PR from another account, if available | No approval, log `not in autoApproval.allowedActors` |
| 3.6 | No double approval | Close and reopen the PR from 3.1 | No second review at the same SHA |
| 3.7 | New commit re-approves | Push a commit to the PR from 3.1 | Fresh approval pinned to the new SHA, without needing to reopen — `synchronize` is now handled |
| 3.9 | Protected path on a later push | Push a commit editing `.github/woodhouse.yml` to an already-approved PR | No new approval; the guard re-runs on every push |
| 3.8 | Disabled | Set `autoApproval.enabled: false` | No approvals |

## Phase 4 — config validation

| # | Test | Action | Expected `woodhouse/config` |
| --- | --- | --- | --- |
| 4.1 | Valid change | PR editing `.github/woodhouse.yml` validly | success |
| 4.2 | Broken YAML | `foo: [unclosed` | failure, "Not valid YAML" |
| 4.3 | Typo'd key | `autoApproval: { allowedActor: [me] }` | failure naming the unknown key |
| 4.4 | Unmanageable setting | `repository: { private: true }` | failure — not in the schema on purpose |
| 4.5 | Not triggered | PR touching only `README.md` | No `woodhouse/config` check at all |

## Phase 5 — settings sync (destructive; do this last)

Set `settings.enabled: true` in the baseline, but go back to `DRY_RUN=true`
first and read the intended changes before letting it write.

| # | Test | Action | Expected |
| --- | --- | --- | --- |
| 5.1 | Dry run | Push to default branch | Log `DRY_RUN: would apply N change(s)` listing each. **Verify before proceeding** |
| 5.2 | Apply | `DRY_RUN=false`, push again | Settings match config; log `Applied N change(s)` |
| 5.3 | Idempotent | Push again with no config change | `Repository already matches configuration` — no writes |
| 5.4 | Local override wins | Confirm Issues is **off** | `has_issues: false` from the local file beat the baseline's `true` |
| 5.5 | Labels created | Check the labels page | `bug` and `dependencies` exist with the right colours |
| 5.6 | Label rename | Add `- {name: "won't fix", from: wontfix}` after creating `wontfix` | Renamed, not duplicated |
| 5.7 | Rename is idempotent | Push again | No error, no second rename |
| 5.8 | Prune | Add a junk label by hand, set `pruneLabels: true` | Junk label removed; managed labels untouched |
| 5.9 | Branch protection | Add a `branchProtection.main` block | Applied to `main` |
| 5.10 | Missing branch ignored | Add `branchProtection.nonexistent` | Skipped silently, no failure |
| 5.11 | Non-default branch ignored | Push to a feature branch | No sync runs |
| 5.12 | Permission error is legible | Temporarily remove `administration: write` | Log explains the missing permission rather than a bare 403 |
| 5.13 | Plan limit is legible | Make the repo private, keep a `branchProtection` block | Log explains that both branch protection and rulesets need a public repo or a paid plan — not a bare 403 |
| 5.14 | **Merge walk** | Open a PR flipping a `repository` option in `.github/woodhouse.yml`, merge into `main` | Comment on the PR lists what was applied per area, ending `_Woodhouse, at your service._` |
| 5.15 | Re-delivery updates in place | Redeliver the `pull_request.closed` event from the App's *Advanced* tab | The same comment is edited, not a second one |
| 5.16 | Close without merge | Close a settings PR without merging | No sync, no comment |
| 5.17 | Feature-branch merge | Merge a settings PR into a feature branch | No sync, no comment |
| 5.18 | Disabled on merge | Merge a PR setting `settings.enabled: false` | No sync, no comment; log only |
| 5.19 | Merge push already applied | With `DRY_RUN=false`, merge a settings PR | Comment says the settings are in effect and nothing further needed changing |
| 5.20 | Baseline merge | Merge a settings PR in `.github-private` | Comment states the baseline was synced directly and other repositories adopt the change at their next event |

## Phase 6 — end to end

1. Add `woodhouse/white-glove` as a required status check on `main`.
2. Open a PR as `gunzy83` changing `README.md`.
3. Expect: auto-approved, CI runs, white-glove goes green, PR is mergeable
   with a single required check.
4. Open a PR titled `[fail-build]` and confirm merge is blocked.

---

## Phase 7 — multi-App routing

Only relevant once a second App is registered.

| # | Test | Action | Expected |
| --- | --- | --- | --- |
| 7.1 | Both Apps start | Boot with two Apps configured | One `Registered GitHub App` line each; `/healthz` reports `apps: 2` |
| 7.2 | Isolation | Trigger an event in org A | Handled by org A's App only; org B's logs are silent |
| 7.3 | Cross-tenant rejected | Point org A's App at org B's owner | `decision: rejected`, `not-allowlisted` |
| 7.4 | Unknown App | POST with an unrecognised target ID header | 404, warning logged |
| 7.5 | Bad signature | POST signed with the wrong secret | 400, no handler runs |
| 7.6 | Misconfigured App | Unset one App's `APP_ID` | Container exits 78 naming the App, rather than starting half-configured |

## Known gaps to confirm, not bugs

These are current design limits worth observing during testing so they are
deliberate choices rather than surprises:

- **Nothing comments on the PR** when config validation fails — the failure is
  only visible in the Checks tab. Tracked in `TODO.md`.
- **Grace period timers do not survive a restart.** If Woodhouse restarts
  during the grace window on a PR with no CI, the check stays `in_progress`
  until the next push or manual re-run.
- **Neither branch protection nor rulesets work on a private repo on the Free
  plan.** Both need the repo to be public, or a paid plan. Make the test
  repository public to exercise phase 5.9, or expect a clearly-explained
  failure.
- **Every check ignored still yields success.** If CI ran but every check is in
  `ignoredChecks`, white-glove passes. This is distinct from the empty case,
  which is now held pending during the grace period.
