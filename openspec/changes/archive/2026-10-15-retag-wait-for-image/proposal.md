# Proposal

## Why

The re-tag job races `ci.yml`'s image build on every release cut: release-please finishes in seconds while the image job queues behind lint and test and then runs a QEMU multi-arch build, so the re-tag attempt fails almost deterministically and each release costs one manual re-run. Once the app settles into maintenance, releases should be hands off — the job should heal itself.

## What Changes

- The re-tag job gains a bounded wait: before re-tagging, it polls `docker buildx imagetools inspect` on the short-SHA source ref every 30 seconds, up to 20 minutes, then fails loudly with a message pointing at the runbook recovery. Chaining, outputs, permissions, and the two `imagetools create` invocations are unchanged.
- The workflow's race comments and the README runbook's re-tag bullet are rewritten to tell the new story: the normal path waits and completes; the timeout recovery (including the `cancel-in-progress` edge) is the fallback.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `releases`: the images-tagged-with-release-versions-without-rebuilding requirement gains bounded-wait behavior — the re-tag waits for the release commit's image to exist instead of failing while the push build is still running, and fails loudly on timeout.

## Impact

- `.github/workflows/release.yml` — one wait step inside the existing `retag-image` job; no new jobs, no removed steps, no permission changes.
- `README.md` — the release runbook's re-tag race bullet.
- Ordering dependency: add-release-please must archive before this change archives — its archive creates `openspec/specs/releases/`, and the archive step refuses a MODIFIED delta against a capability spec that does not exist. `openspec validate` passes now and prints the same constraint as an INFO.
