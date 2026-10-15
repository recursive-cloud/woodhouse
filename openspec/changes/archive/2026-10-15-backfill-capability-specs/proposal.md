# Proposal

## Why

The spec inventory claims only two of Woodhouse's surfaces — `settings-sync` and `auto-approval`. The flagship behaviors (the white-glove verdict, config validation, installation lockdown, multi-App serving) are implemented and exercised against real repositories but un-specced, so the 1.0 claim rests on code and TODO prose rather than on capability specs. Backfilling them now — before the round's feature changes — means every later change lands as a reviewable spec delta against a baseline instead of authoring its own.

## What Changes

- Four new capability specs written from the implemented behavior, with no code changes: `gatekeeper` (the white-glove consolidated check: verdict semantics, fail-closed conclusions, strict and ignored checks, the no-CI grace period, check lifecycle, silence when disabled), `config-validation` (pull-request-time validation of settings files: triggers, the four exact paths, the `woodhouse/config` check, the managed comment with the schema modeline), `installation-lockdown` (the security boundary: allowlist enforcement before any handler, owner resolution and its fallbacks, startup refusals), `multi-app-operation` (one Probot per App with its own secret, header-based routing before verification, delivery outcomes, boot-time validation).
- Requirements are extracted from actual behavior (source and tests), not aspiration. Any code-vs-spec tension found while writing is recorded as a follow-up note in the change directory, not silently smoothed over and not fixed here.

## Capabilities

### New Capabilities

- `gatekeeper`: the white-glove consolidated check — one verdict over every other check on a pull request's head commit, fail-closed on unknown conclusions, with strict and ignored checks and a grace period for commits CI has not reached yet.
- `config-validation`: pull-request-time validation of settings files — which pull requests trigger it, the exact settings paths, the `woodhouse/config` check run, and the single managed comment that explains invalid configuration.
- `installation-lockdown`: the hard security boundary — the installation allowlist every delivery passes before any handler runs, owner resolution and its fallbacks, and the startup refusals that make a boundaryless configuration fatal.
- `multi-app-operation`: serving several GitHub Apps from one container — per-App Probot instances and webhook secrets, routing by GitHub's target header before signature verification, and delivery outcomes.

### Modified Capabilities

- none — `settings-sync` and `auto-approval` are already specced and are not touched. Config resolution and cascading is deliberately excluded (see design Non-Goals).

## Impact

- `openspec/changes/backfill-capability-specs/specs/` only — four new capability spec deltas; no source, test, or configuration changes.
- On archive, `openspec/specs/` gains the four capabilities, and later changes in this round (`open-onboarding-pr` in particular) delta against them.
