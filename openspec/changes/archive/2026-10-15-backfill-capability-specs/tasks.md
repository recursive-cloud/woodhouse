# Tasks

## 1. Gatekeeper capability spec

- [x] 1.1 Write `specs/gatekeeper/spec.md` from the implemented verdict logic (aggregation, fail-closed conclusions, strict/ignored checks, grace period, check lifecycle, silence when disabled), tracing each requirement to `src/gatekeeper/` and its tests. Verify with `openspec validate backfill-capability-specs`.
- [x] 1.2 Record the requirement-to-test mapping (and any scenario covered only by comments/docs) in a `notes.md` in the change directory. Verify the mapping names a real test or source location for every scenario.

## 2. Config-validation capability spec

- [x] 2.1 Write `specs/config-validation/spec.md` from the validation flow (triggers, the four settings paths, the `woodhouse/config` check, marker-comment lifecycle, modeline suggestion, dry-run, the removed-file carve-out), tracing each requirement to `src/settings/validate.ts` and its tests. Verify with `openspec validate backfill-capability-specs`.
- [x] 2.2 Extend `notes.md` with this capability's mapping, recording the removed-file carve-out (a deletion-only settings change posts no check) as follow-up material. Verify every scenario names a real test or source location.

## 3. Installation-lockdown capability spec

- [x] 3.1 Write `specs/installation-lockdown/spec.md` from the boundary behavior (allowlist before any handler, owner resolution fallbacks, sender exclusion, startup refusals, wildcard rejection), tracing each requirement to `src/security/` and `src/apps/registry.ts` and their tests. Verify with `openspec validate backfill-capability-specs`.
- [x] 3.2 Extend `notes.md` with this capability's mapping. Verify every scenario names a real test or source location.

## 4. Multi-app-operation capability spec

- [x] 4.1 Write `specs/multi-app-operation/spec.md` from the serving behavior (per-App Probot instances and secrets, header routing before verification, delivery outcomes, boot-fatal configuration mistakes, health endpoint), tracing each requirement to `src/server.ts` and `src/apps/registry.ts` and their tests. Verify with `openspec validate backfill-capability-specs`.
- [x] 4.2 Extend `notes.md` with this capability's mapping. Verify every scenario names a real test or source location.

## 5. Whole-change verification

- [x] 5.1 Run `mise run ci` — must be green with zero source changes, proving the change is documentation-only.
- [x] 5.2 Run `openspec validate backfill-capability-specs` for the final artifact check, and review `notes.md` for follow-up-worthy gaps worth surfacing at archive time.
