# Notes

## Apply-time corrections (2026-10-15)

Three plan-vs-reality corrections from the group-1 review, each verified
against release-please's own docs and the `@v4` action's README:

1. **`"include-component-in-tag": false`** is required in
   `release-please-config.json`. Without it, release-please@17 (the major the
   `@v4` action resolves) derives the component from `package.json`'s `name`
   and cuts `woodhouse-v1.0.0` with PR title `chore(main): release woodhouse
   1.0.0` — verified empirically by running release-please@17.11.2 against
   this repo's exact config. The design's `v1.0.0` tag and `chore(main):
   release 1.0.0` title need the flag. Precedent: release-please's own
   self-release config sets it. Recorded in design D2.
2. **The release-please job's permissions are `contents: write`, `issues:
   write`, `pull-requests: write`**, not `contents: write` alone. Creating
   the release pull request needs `pull-requests: write`; labeling it
   `autorelease: pending` needs `issues: write`, and the label is
   load-bearing — release-please recognizes its own PRs by it, so an
   unlabeled release PR would merge without ever being tagged. Source: the
   action's README, "Workflow Permissions". The spec requirement, design D1,
   task 1.1 and the proposal summary were amended to this set; the
   least-privilege intent is unchanged (per-job grants; no
   pull-request-triggered workflow holds any write).
3. **The re-tag job chains from the release-please job's outputs (`needs` +
   `if` on `release_created`), not a `release: published` event.** Releases
   created with the default `GITHUB_TOKEN` do not trigger workflow events —
   the action's README states this explicitly — so an event-triggered re-tag
   job would never run. `tag_name` and `sha` come from the action's
   root-component outputs; this also drops the checkout step, so the re-tag
   job holds `packages: write` and nothing else. Design D3, task 2.1 and the
   proposal summary were amended accordingly.

Known tradeoff recorded in the design's risks: the release pull request
itself runs no CI checks — pull requests created with the default
`GITHUB_TOKEN` do not trigger workflows. Accepted: the release PR's content
is generated from commits that already passed CI on their own pull requests.

Operator prerequisite for the first release-please run: repository
Settings → Actions → General must have "Allow GitHub Actions to create and
approve pull requests" enabled, or the `GITHUB_TOKEN` cannot open the release
PR. At apply time it was **disabled** (`can_approve_pull_request_reviews:
false`, via the repo `actions/permissions/workflow` API) — it must be
enabled before the first push to main after this change merges.

## Follow-through (post-merge, 2026-10-15)

- The operator prerequisite was resolved before the merge: "Allow GitHub
  Actions to create and approve pull requests" was enabled at the **org**
  level (the repo-level setting was greyed out because the org setting was
  disabled); the repo endpoint now reports `can_approve_pull_request_reviews:
  true`.
- PR #11 merged as `76e0bbb`. GitHub required one-time manual approval for
  the new `release.yml` workflow file's first run; subsequent runs go
  automatically.
- The first release-please run succeeded and opened the 1.0.0 release pull
  request — task 4.2's observation:
  https://github.com/recursive-cloud/woodhouse/pull/12
  (`chore(main): release 1.0.0`, labeled `autorelease: pending`).
- On PR #11's merge the re-tag job correctly **skipped** (`release_created`
  false — opening the release PR is not cutting a release). The documented
  re-tag race engages on the release PR's merge; the bounded-wait
  self-healing fix is proposed as the `retag-wait-for-image` change.
