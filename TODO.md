# TODO

Deferred work, roughly in the order it is worth doing.

## Where things stand

Lockdown, cascading settings sync, the white-glove check, auto-approval, config
validation and onboarding are implemented and verified against real
repositories. The **1.0 acceptance run** passed every phase (report at
`docs/acceptance/2026-10-18/`); two Apps run in one container; CI builds a
multi-arch image per commit.

What remains for 1.0: the pre-1.0 polish pull request and the 1.0 release
itself, through release-please's accumulating pull request. Acceptance-run
findings are tracked as GitHub issues (#24-#29) and pulled in one by one; this
file does not repeat them.

## Post-1.0

- [ ] **`woodhouse/dress-code` — enforce conventional-commit PR titles.**
      Woodhouse-native, because a ruleset `commit_message_pattern` rule is
      not a PR-title gate: it evaluates commits on the head branch at merge
      time, blocks squash merges on intermediate commits, and rulesets do
      not exist on private Free repositories anyway. Title-only first pass —
      a named check validating the PR title against the conventional-commit
      pattern, re-checked on `pull_request.edited` (title edits; nothing
      listens for that event today). Only meaningful when the squash commit
      title is the PR title, so dress-code enabled requires the repository
      merge settings coupled accordingly — squash merges with
      `squash_merge_commit_title: PR_TITLE`, rebase and merge-commit
      disabled, enforced by config validation — until a v2 all-commits mode
      supports rebase shops. GitHub's merge-time `(#N)` suffix never reaches
      the check (titles are validated pre-merge).

- [ ] **Repository environments.** Environments and their protection rules
      as a settings area. Slots into the apply pipeline cleanly: ruleset
      rules already carry `required_deployments` (environment names) through
      the passthrough.

- [ ] **Derive `strictChecks` from ruleset required checks.** The
      gatekeeper's strict checks and a ruleset's `required_status_checks`
      are hand-mirrored today; deriving one from the other removes the
      drift. Deferred from the ruleset hardening.

- [ ] **Bypass actor-ID lookups.** `bypass_actors` takes numeric actor IDs;
      resolving teams, roles and logins to IDs would remove the archaeology.
      Deferred from the ruleset hardening.

- [ ] **Auto-approval wording customisation.** The owners/bots
      review-comment wording is fixed; per-config wording is the stretch
      goal (see `docs/owners-bots-auto-approval.md`).

- [ ] **Per-App health and metrics.** `/healthz` reports how many Apps are
      served but not whether each authenticates; a bad private key is only
      visible as failing deliveries.

- [ ] **Consider deriving the allowlist from actual installations.**
      `GET /app/installations` is authoritative for a private App and would
      remove the allowlist from configuration. Rejected so far: it silently
      widens the boundary if an App ever goes public, and installations
      change at runtime. Revisit only if configuring it proves genuinely
      annoying.

## Developer experience

- [ ] **Re-enable Markdown formatting when oxfmt stabilises.** oxfmt 0.67
      does not converge on a list item containing a second paragraph (it
      re-indents the continuation lines on every run). Worth retrying at
      1.0, and worth reporting upstream.

- [ ] **Slower linters on pre-push.** actionlint, hadolint, zizmor and
      dclint are all useful and none fast enough for pre-commit;
      `pre-push` is the right home, with CI as backstop.

- [ ] **Revisit the oxlint categories.** `correctness`, `suspicious` and
      `perf` are enabled; `pedantic` produced 127 findings and was not
      adopted. Worth working through selectively. `no-await-in-loop` stays
      off — the sequential API calls in `settings/apply.ts` are deliberate.

- [ ] **Consider `hk install --global`.** Belongs in dotfiles rather than
      here; if adopted, the per-repo install becomes redundant and hk skips
      it automatically.

## Accepted tradeoffs

Recorded so they are not rediscovered as bugs. Revisit only if the premise
changes.

- **Grace period timers do not survive a restart.** A restart during the
  grace window on a pull request with no CI leaves the white-glove check
  `in_progress` until the next push or manual re-run. The fix arrives with
  the datastore HA would need anyway.

- **App configuration is read once at boot.** Adding or changing a tenant
  means restarting the container.

- **Rulesets converge by unconditional re-declaration.** GitHub's ruleset
  reads are normalised and cannot be diffed against the planned body, so
  every sync re-PUTs each configured ruleset. Idempotent, and no
  user-visible change when the content already matches; specced in
  `settings-sync`.

- **`pruneRulesets` is converge-everything, not managed-only.** Opt-in
  (default off): deletes every ruleset absent from the configuration,
  hand-made included — the API offers no ownership marker. Documented in
  the schema descriptions.

- **Single replica by design.** Per-commit work is serialised in-process
  (`src/lib/mutex.ts`) and the config cache is in-process. Redis comes
  first, before any second replica.

## Deferred / revisit

- [ ] **Image signing and provenance.** `provenance: false` keeps the GHCR
      package listing clean. Worth revisiting with cosign signing and SBOM
      generation.

- [ ] **`docker/*` actions still target Node 20.** Already the latest
      released majors; upstream — recheck periodically.
