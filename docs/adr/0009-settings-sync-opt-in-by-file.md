# 0009. Settings Sync Opts In by Config File Presence

Status: Accepted

## Context

`settings.enabled` began life as a master switch defaulting off: installing the App had to not silently start rewriting repository settings until the operator explicitly asked. That default made the flag the only opt-in, so a repository whose own `.github/woodhouse.yml` declared `enabled: true` outside the baseline still synced nothing, with no error and no signal (REC-14). It also left every repository managed only through the baseline in limbo the moment the operator wanted per-repository control.

The fail-closed posture the old description encoded was right about one thing — a broken or missing configuration must not turn into writes — but wrong about the consent mechanism: silence is not a way to withhold consent the operator never had the chance to give.

## Decision

We will treat the presence of `.github/woodhouse.yml` (or `.yaml`) in a repository as the signal that the repository accepts settings management. A repository without its own settings file is never synced; it is offered the onboarding pull request instead.

`settings.enabled` stays in the schema as a kill switch with an implicit default of `true`. An explicit `false` at any level of the cascade silences sync for that repository, and a repository-level `true` overrides a baseline `false`.

The baseline file's role is fixed by the same review (operator, 2026-11-17): `woodhouse.yml` in the root of the `.github-private` repository is exclusively the owner-wide baseline, for the baseline repository included — it does not manage the baseline repository itself. `.github/woodhouse.yml` is the management trigger in every repository, the baseline repository included, so the resolver has no per-repository special case.

## Options Considered

- Keep `enabled` as the master switch and fix the reported no-op by surfacing an error: preserves the old posture but keeps consent implicit and inherited, and still needs a signal path for the mismatch the bug exposed.
- Let file presence alone override a baseline `false`: makes the baseline kill switch dead configuration and contradicts the cascading model.

## Consequences

- Every repository the baseline managed without a local file stops being synced until it accepts onboarding (accepted; the walk now offers to any repository without a local file, the baseline repository included).
- The gate preserves ADR 0002's fail-closed behaviour at the boundary: a resolution that produced validation issues syncs nothing, and a local file that fails to parse is not an opt-in.
- Known open boundary, tracked separately: an unparseable local file leaves the repository unmanaged with only a warn log; the decided direction is to raise an issue on the repository until the configuration parses again.
- Merging a baseline-file change syncs other repositories at their next event; the baseline repository itself syncs only if it carries its own `.github/woodhouse.yml`, and the merge comment follows the same gate.
