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
   written back to GitHub. Leave it on until phase 3.
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
[gunzy83]` inherited, and `ignoredChecks: [advisory]` local.

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
| 3.3 | Ready for review | Mark the draft ready | Still no approval — only `opened`/`reopened` are handled. *Expected gap; see below* |
| 3.4 | **Protected path** | PR editing `.github/woodhouse.yml` | **No approval**, log `modifies protected path`. The privilege-escalation guard |
| 3.5 | Untrusted author | PR from another account, if available | No approval, log `not in autoApproval.allowedActors` |
| 3.6 | No double approval | Close and reopen the PR from 3.1 | No second review at the same SHA |
| 3.7 | New commit re-approves | Push a commit to the PR from 3.1, close/reopen | Fresh approval pinned to the new SHA |
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

## Phase 6 — end to end

1. Add `woodhouse/white-glove` as a required status check on `main`.
2. Open a PR as `gunzy83` changing `README.md`.
3. Expect: auto-approved, CI runs, white-glove goes green, PR is mergeable
   with a single required check.
4. Open a PR titled `[fail-build]` and confirm merge is blocked.

---

## Known gaps to confirm, not bugs

These are current design limits worth observing during testing so they are
deliberate choices rather than surprises:

- **`ready_for_review` is not handled** (3.3). A PR opened as a draft is never
  auto-approved, even after being marked ready. Adding it is a one-line change
  if it turns out to be annoying in practice.
- **`pull_request.synchronize` does not re-approve.** A new commit does not get
  a fresh automatic approval; the PR must be reopened. This is the safe
  direction, but may be tedious for Renovate branches that update repeatedly.
- **Nothing comments on the PR** when config validation fails — the failure is
  only visible in the Checks tab. Tracked in `TODO.md`.
- **Zero evaluated checks yields success.** If every check on a commit is in
  `ignoredChecks`, white-glove passes rather than hanging. Intentional, so that
  docs-only PRs with no CI are not deadlocked.
