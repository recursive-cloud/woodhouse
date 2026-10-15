# Tasks

## 1. Bounded wait in the re-tag job

- [x] 1.1 Add the wait step to `release.yml`'s `retag-image` job (after Set up Buildx, before the create steps): poll `docker buildx imagetools inspect` on `${{ steps.tags.outputs.source }}` every 30 seconds, up to 20 minutes, then exit 1 with a message pointing at the runbook recovery (name the likely causes: CI's image build cancelled by a further push, or failed). The inspect must sit in an `if`/`while` condition — run steps default to `bash -e`, so a bare sequenced inspect aborts on the first miss and silently reintroduces the race — and each attempt logs `attempt i/40`. Rewrite the "may still be running / re-running this failed job" comment block to describe the wait. Verify with `npx oxfmt --check .`.
- [x] 1.2 Rewrite the README runbook's re-tag race bullet: the job waits for the image build (bounded), naming the 20-minute bound so the runbook matches the workflow; on timeout — e.g. the build was cancelled by a further push to main — re-run CI's image job first, then the re-tag job. Verify `npx oxfmt --check .` passes and no "expect it to fail" wording survives.
- [x] 1.3 Run the group's verification: `npx oxfmt --check .`; locally, with buildx installed, `docker buildx imagetools inspect ghcr.io/recursive-cloud/woodhouse:76e0bbb` succeeds and a deliberately bogus tag fails (the failure mode the poll keys on); `mise run ci && npm run schema:check`. `openspec validate retag-wait-for-image` passes now and prints an INFO that the archive step will refuse this MODIFIED delta until add-release-please's archive has landed and created `openspec/specs/releases/` — expect that INFO, do not treat it as a defect.

## Workflow follow-up

- add-release-please must archive (its archive PR merged) before this change archives — this change's MODIFIED delta targets the `releases` capability spec that add-release-please's archive creates.
- Archive this change after the project's review requirements are satisfied.
