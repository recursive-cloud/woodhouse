# Notes

Requirement-to-evidence mapping for the backfilled capability specs. Every
scenario names a real test or a real source location; anything covered only by a
comment or the docs walk — or not covered at all — is flagged
**gap — follow-up material** rather than smoothed over. Later task groups append
their capability sections below.

## Gatekeeper

Spec: `openspec/changes/backfill-capability-specs/specs/gatekeeper/spec.md`.
Primary source: `src/gatekeeper/evaluate.ts:evaluate` (pure verdict logic).
Lifecycle/wiring source: `src/gatekeeper/handler.ts` (`reconcile`, `upsertCheck`,
`listCheckRuns`, `findExisting`) and `src/app.ts` (listener registration,
`seedAndSchedule`). No spec edits were needed — the spec matches the
implementation. The only code-vs-spec divergences are the `gracePeriodSeconds: 0`
edge recorded under Gaps and the suite-completes-mid-grace early settle recorded
under Requirement 5; both are documented there rather than smoothed over.

### Requirement: A consolidated check is maintained per pull request

- **Requirement statement** (create when absent / update in place / never
  duplicate) → `src/gatekeeper/handler.ts:upsertCheck` (72-117) using
  `src/gatekeeper/handler.ts:findExisting` (119-134); concurrency serialised by
  `src/lib/mutex.ts:KeyedMutex` keyed `owner/repo@sha`
  (`src/gatekeeper/handler.ts:reconcile`, 160). **Gap — no test**: nothing
  exercises the create-vs-update branch. The docs walk records it
  (`docs/test-plan.md` 2.12, "Re-run … Check updates rather than duplicating").
  The mutex is tested only for the settings-sync path
  (`test/settings-concurrency.test.ts > "merge push and merged pull request race"`).
- **Scenario "Pull request opens"** → `src/app.ts` listener
  `white-glove:pull_request` (208-220) calling `seedAndSchedule`
  (174-206) → `src/gatekeeper/handler.ts:reconcile`.
  **Gap — no test**: no test delivers `pull_request.opened` through `createApp`
  for the gatekeeper (the only `createApp` test,
  `test/settings-concurrency.test.ts`, drives settings sync).
- **Scenario "Another check completes"** → `src/app.ts` listener
  `white-glove:check_run` (131-147); verdict re-derivation covered by
  `test/evaluate.test.ts > "evaluate — basic outcomes" > "passes when every check succeeded"`.
- **Trigger: completed check suite** → `src/app.ts` listener
  `white-glove:check_suite` (152-161), reconciling on `check_suite.head_sha`.
  **Gap — no test** for the wiring.
- **Scenario "Re-requested"** → `src/app.ts` listener
  `white-glove:rerequested` (223-240), dispatching `check_run.rerequested` /
  `check_suite.rerequested`. **Gap — no test**.
- "except the consolidated check itself" (self-loop guard) →
  `src/gatekeeper/handler.ts:isSelfCheck`; `test/evaluate.test.ts >
  "evaluate — self-reference" > "never evaluates its own check run"`.

### Requirement: The verdict aggregates other checks and fails closed

- **Scenario "A child check fails"** → `test/evaluate.test.ts >
  "evaluate — basic outcomes" > "fails on a failure"` and `> "treats %s as failure"`
  (`FAILING_CONCLUSIONS`, `src/gatekeeper/evaluate.ts:80-87`).
- **Scenario "Unrecognized conclusion"** → `test/evaluate.test.ts >
  "evaluate — defensive cases" > "fails closed on an unrecognised conclusion"`
  (`src/gatekeeper/evaluate.ts:196-204`).
- **Scenario "Non-strict skipped or neutral check passes"** →
  `test/evaluate.test.ts > "evaluate — skipped and neutral" > "ignores %s by default"`
  (`NON_RESULT_CONCLUSIONS`, `src/gatekeeper/evaluate.ts:172-187`).
- **Scenario "Running check holds pending"** → `test/evaluate.test.ts >
  "evaluate — basic outcomes" > "is pending while any check is unfinished"` and
  `> "treats status %s as pending"` (`src/gatekeeper/evaluate.ts:143-151`).

### Requirement: Strict checks must pass explicitly

- **Scenario "Absent strict check holds pending"** → `test/evaluate.test.ts >
  "evaluate — strictChecks presence" > "holds at pending when a strict check never reported"`
  (`src/gatekeeper/evaluate.ts:207-220`).
- **Scenario "Skipped strict check fails"** → `test/evaluate.test.ts >
  "evaluate — skipped and neutral" > "fails on %s when the check is strict"`.
- **Scenario "Strict beats ignored"** → `test/evaluate.test.ts >
  "evaluate — ignoredChecks" > "gives strict precedence over ignored when both list a check"`
  (`src/gatekeeper/evaluate.ts:130-141`).

### Requirement: Ignored checks are excluded

- **Scenario "Advisory check ignored"** → `test/evaluate.test.ts >
  "evaluate — ignoredChecks" > "excludes ignored checks even when they fail"`
  (also `> "excludes ignored checks that are still running"`).
- Matching detail: `src/gatekeeper/evaluate.ts:nameMatches` (103-106) is exact,
  case-insensitive and trimmed. Only the strict case-insensitivity has a test
  (`"evaluate — strictChecks presence" > "matches strict check names case-insensitively"`);
  ignored-name case-insensitivity has none. Not a spec mismatch (the schema
  itself says "by exact name") — recorded as a minor coverage note, see Gaps.

### Requirement: Commits without checks get a grace period, then pass

- **Scenario "Inside the grace window"** → `test/evaluate.test.ts >
  "evaluate — grace period for checks that have not started" > "holds pending on an empty commit while emptyIsPending is set"`
  (`EvaluateOptions.emptyIsPending`, `src/gatekeeper/evaluate.ts:51-61, 222-228`).
  The "a re-check is scheduled after the grace period" half →
  `src/app.ts:seedAndSchedule` (174-206) + `src/lib/scheduler.ts:Scheduler`.
  The Scheduler is unit-tested
  (`test/scheduler.test.ts > "Scheduler"`), but the `seedAndSchedule` wiring
  itself is **gap — no test**.
- **Scenario "No CI at all"** → `test/evaluate.test.ts >
  "evaluate — grace period…" > "concludes success on an empty commit once the grace period is over"`;
  the scheduled second pass that drops `emptyIsPending` is
  `src/app.ts:198-205` (**gap — no test** for the wiring).
- **Deliberate early settle (tension with this requirement)** → `src/app.ts:152-161`
  (`white-glove:check_suite`) reconciles with no `emptyIsPending`; the source
  comment (app.ts:149-151) explains why — a suite can complete having produced
  no check runs (e.g. every workflow filtered out by `paths`), and without this
  the grace period would be the only thing resolving that case. A paths-filtered
  suite completing mid-grace therefore settles the verdict (possibly on success)
  before `gatekeeper.gracePeriodSeconds` elapses, short-circuiting a plain
  reading of this requirement. Deliberate and documented in source;
  **gap — no test**.

### Requirement: Silence when the gatekeeper is disabled

- **Scenario "Gatekeeper disabled"** → `src/gatekeeper/handler.ts:reconcile`
  (164-167) early-returns before listing/evaluating/writing when
  `gatekeeper.enabled` is false. **Gap — no test**: no test sets
  `gatekeeper.enabled: false` and asserts no check write.

### Gaps — follow-up material

1. **`gatekeeper.gracePeriodSeconds: 0` deadlocks a no-CI pull request.**
   `src/app.ts:seedAndSchedule` reconciles with `emptyIsPending: true` (writing
   the check `in_progress`) and then `if (graceMs === 0) return;` (190-191)
   schedules nothing. The schema allows `0`
   (`src/config/schema.ts:66`, `min(0)`). Because the re-check that would settle
   on success is never scheduled, a PR with genuinely no check runs stays
   `in_progress` indefinitely — the opposite of the schema's stated intent
   ("afterwards, a commit with genuinely no checks passes"). This is a code wart,
   so the spec keeps the designed grace-then-pass requirement rather than
   blessing the deadlock; flagged here for a follow-up fix.
2. **The handler/wiring layer has no tests.** `reconcile`, `upsertCheck`,
   `listCheckRuns`, `findExisting`, and the `src/app.ts` gatekeeper listeners are
   covered only by source and by the manual walk in `docs/test-plan.md`
   (2.2, 2.11-2.13). Every scenario that depends on lifecycle/wiring rather than
   the pure evaluator is marked "gap — no test" above.
3. **Ignored-name case-insensitivity is untested** (only strict case-insensitivity
   is pinned). Minor coverage note, not a spec gap.
4. **`startup_failure` is the untested member of `FAILING_CONCLUSIONS`.**
   `src/gatekeeper/evaluate.ts:80-87` lists six failing conclusions, but
   `test/evaluate.test.ts:32` pins only `failure`, `timed_out`, `cancelled`,
   `action_required` and `stale`. Minor coverage note, not a spec gap; the
   eventual fix is to fold `startup_failure` into that `it.each` list
   (test-only — follow-up material, not done here).
5. **Restart bound on Requirement 5** — the grace-period timer is in-process
   (`src/lib/scheduler.ts` `cancelAll` note), so a restart mid-grace leaves the
   check `in_progress` until the next event. This is the accepted tradeoff in
   `TODO.md` ("Grace period timers do not survive a restart") and
   `docs/test-plan.md` ("Known gaps to confirm, not bugs"), deliberately kept out
   of the spec per design D3. Noted only because it bounds Requirement 5's
   "the commit SHALL pass"; do not turn it into a requirement.

### Candidate tests checked (per the brief)

`test/pulls.test.ts` (`src/github/pulls.ts`), `test/dry-run.test.ts`
(`src/lib/dry-run.ts:performWrite`), `test/settings-concurrency.test.ts`
(settings sync), and `test/silver-platter.test.ts` (auto-approval) contain no
gatekeeper assertions. The gatekeeper's automated coverage is
`test/evaluate.test.ts` (pure evaluator) and `test/scheduler.test.ts` (the
grace-period timer primitive).

## Config-validation

Spec: `openspec/changes/backfill-capability-specs/specs/config-validation/spec.md`.
Primary source: `src/settings/validate.ts` (`CONFIG_CHECK_NAME`, `COMMENT_MARKER`,
`isConfigPath`, `validateDocument`, `summarise`, `buildComment`, `syncComment`,
`validatePullRequest`); path set `src/config/paths.ts:SETTINGS_PATHS`;
comment mechanics `src/github/comments.ts:syncMarkerComment`; dry-run guard
`src/lib/dry-run.ts:performWrite`; listener `src/app.ts:291-309`.
Two spec edits were made — Requirement 5 (dry-run) over-claimed that the issue
text and comment body are logged (corrected to match `performWrite`, which logs
one `DRY_RUN: would <label>` line per suppressed write), and Requirement 1 gained
the non-regular-file carve-out and its scenario.

### Requirement: Pull requests touching settings files are validated

- **"four settings paths" claim confirmed literally** → `src/config/paths.ts:12-18`
  (two local overrides + two baselines), asserted by
  `test/paths.test.ts > "isSettingsPath" > "classifies exactly the exported local and baseline paths"`.
- **Read at head / validate against schema** → `src/settings/validate.ts:validatePullRequest`
  (187-219), `validateDocument` (50-73).
- **Removed file is not read** → `src/settings/validate.ts:197-199`
  (`file.status !== "removed"`; empty set → `return undefined`).
  **Gap — no test** (carve-out, see Gaps).
- **Scenario "Pull request adds a local config"** → `src/app.ts:291-309` listener
  (`pull_request.opened`/`reopened`/`synchronize`) → `validatePullRequest`.
  Path recognition pinned by `test/paths.test.ts > "isSettingsPath" > "matches the
  exact path %s"` and `test/validate.test.ts > "isConfigPath" > "recognises %s"`.
  **Gap — no test** drives `validatePullRequest`.
- **Scenario "Baseline config pull request"** → `test/paths.test.ts >
  "isSettingsPath" > "matches the exact path woodhouse.yml"`;
  `test/validate.test.ts > "isConfigPath" > "recognises woodhouse.yml"`.
  **Gap — no end-to-end test**.
- **Scenario "Near-miss filename"** → `test/paths.test.ts > "isSettingsPath" >
  "rejects the near-miss docs/woodhouse.yml"`; `test/validate.test.ts >
  "isConfigPath" > "ignores src/woodhouse.yml"`. **Gap — no test** that
  `validatePullRequest` returns `undefined` with no check.
- **Scenario "Deletion is not validated"** → `src/settings/validate.ts:197-199`.
  **Gap — no test** (same carve-out).
- **Scenario "Non-regular file is not validated"** → `src/settings/validate.ts:213-214`
  (`blob.type !== "file"` / non-string `content` skipped) and `:221` (no verdicts →
  `undefined`). **Gap — no test** (same silent-bypass family).

### Requirement: The validation verdict is a check run

- Source: `src/settings/validate.ts:CONFIG_CHECK_NAME` (22), `summarise` (75-119),
  `checks.create` (226-235).
- **Scenario "Valid configuration"** → `test/validate.test.ts > "summarise" >
  "passes when every document is valid"`; `> "validateDocument" > "accepts a valid document"`.
  **Gap — no test** asserts the check run is created.
- **Scenario "Invalid configuration"** → `test/validate.test.ts > "summarise" >
  "fails and names every bad file"`; `> "validateDocument" > "reports a schema error
  with a usable path"` and `> "reports invalid YAML"`; schema layer
  `test/config.test.ts > "config schema" > "rejects unknown keys so typos are not
  silently ignored"`. **Gap — no test** asserts the check run is created.
- Aggregation into the white-glove verdict is by name (D4), mapped in the
  Gatekeeper section (`src/gatekeeper/evaluate.ts:evaluate`).

### Requirement: Invalid configuration gets one managed comment

- Source: `buildComment` (`src/settings/validate.ts:128-146`, `COMMENT_MARKER` 31,
  `SCHEMA_MODELINE` `src/config/json-schema.ts:22`), `syncComment` (170-185),
  `syncMarkerComment` (`src/github/comments.ts:52`).
- **Scenario "Comment explains and suggests"** → `test/validate.test.ts >
  "buildComment" > "repeats the errors inline"`, `> "offers the schema modeline so
  the next push is checked locally"`, `> "carries the hidden marker so it can be
  found again"`. **Gap — the failure-path wiring** (`syncComment` with a body) is
  untested.
- **Scenario "Next push fixes the file"** → `test/comments.test.ts >
  "syncMarkerComment" > "deletes the comment when body is undefined and one exists"`;
  success → `undefined` at `src/settings/validate.ts:183`. **Gap — the wiring** is
  untested.
- **Scenario "Re-delivery does not duplicate"** → `test/comments.test.ts >
  "syncMarkerComment" > "updates in place when a comment carrying the marker already
  exists"` and `> "finds the comment by marker, not by author or position"`.

### Requirement: Valid configuration is silent

- Source: `src/settings/validate.ts:syncComment` (183: success → `body: undefined`).
- **Scenario "Valid from the start"** → `test/comments.test.ts > "syncMarkerComment" >
  "writes nothing when the desired state already holds"`; `test/validate.test.ts >
  "summarise" > "passes when every document is valid"`. **Gap — no test** covers the
  combined validate → check + comment flow.

### Requirement: Dry-run never writes

- **Scenario "Dry-run validation"** → `src/lib/dry-run.ts:performWrite` (18-29),
  reached from `src/settings/validate.ts:225` (check) and
  `src/github/comments.ts:56` (comment). Guard unit-tested by `test/dry-run.test.ts >
  "performWrite" > "skips the write and logs the label in dry-run"`; the comment
  manager by `test/comments.test.ts > "syncMarkerComment" > "in dry-run makes zero
  octokit calls and logs a DRY_RUN line"`. **Gap — no test** at the
  `validatePullRequest` level.
- Notes: the guard logs the write *label* only — `DRY_RUN: would write config
  validation check`, `DRY_RUN: would sync comment <!-- woodhouse:config-validation -->`
  — never the issue text or comment body. The spec was corrected to state this.

### Gaps — follow-up material

1. **Removed-file carve-out (known silent bypass).** `src/settings/validate.ts:197`
   drops any changed file whose `status === "removed"`, and a PR whose only settings
   change is a deletion yields an empty `touched` set → `validatePullRequest` returns
   `undefined` → no `woodhouse/config` check is posted at all. Deleting a settings
   file (falling a repository back to defaults) is therefore never validated. No test
   covers it. The spec states the carve-out; recorded here per proposal/tasks 2.2 as
   follow-up material, not smoothed over. Blast radius:
   - **Required-check deadlock family:** if `woodhouse/config` is a required status
     check, the pull request is blocked indefinitely by an expected check nothing will
     ever create — the same shape as the gatekeeper's grace-0 deadlock (see Gap 1 in
     the Gatekeeper section).
   - **Stale marker comment:** a marker comment left by an earlier failed validation is
     never deleted, because `syncComment` (`src/settings/validate.ts:246`) runs only
     after the `touched`/`verdicts` guards pass (`validate.ts:199, 221`) — a later push
     that deletes the settings file never reaches it.
2. **Non-regular-file settings path is silently skipped (same silent-bypass family
   as the carve-out above).** `src/settings/validate.ts:213-214` `continue`s past any
   settings path whose head blob is not a regular file (`blob.type !== "file"` or a
   non-string `content` — a symlink or submodule pointer), and `validate.ts:221`
   returns `undefined` when no verdicts were produced. A PR whose only settings change
   is such a path therefore posts no `woodhouse/config` check and is validated by
   nobody. The spec's Requirement 1 now states this carve-out; no test covers it.
3. **>1 MB settings file is green-lit with a false success (fail-open twin of the
   skip above).** For a file between 1 and 100 MB GitHub's contents API returns
   `content: ""` with `encoding: "none"` (a media-type object response), and
   `src/settings/validate.ts:213-217` does not catch it: `blob.type` is `"file"`,
   `""` is a string, and the code never inspects `blob.encoding`. The empty string
   flows through `Buffer.from("", "base64")` → `validateDocument(path, "")` →
   `yaml.load("")` → `parseConfig({})` → **valid**, because "An empty file is valid:
   it means 'inherit everything'" (`src/settings/validate.ts:68-69`). A settings file
   larger than 1 MB therefore gets a **false success** `woodhouse/config` check for
   content that was never examined — fail-open on a gating check, and the `content`
   half of the same silent-bypass family as the non-regular-file skip above (which
   covers the `type` half). Follow-up fix direction: require
   `blob.encoding === "base64"` (or fetch the raw media type) so a non-base64 payload
   is never treated as empty. Code fix, follow-up material, not done here. The spec is
   deliberately NOT hedged for this one (grace-0 precedent): "SHALL validate each such
   file" is the designed contract and this edge fails it, so it is a code wart to fix
   rather than a carve-out to bless into the baseline — unlike the removed/non-regular
   carve-outs, which are deliberate design and are stated in the spec.
4. **`validatePullRequest` has no test.** The triggers, head-ref reads, removed /
   near-miss filters, check creation and comment wiring are covered only by source,
   by the pure helpers' tests, and by the manual walk (`docs/test-plan.md` Phase 4).
   Every "wiring untested" note above is this one gap.
5. **`woodhouse/config` check runs are created, never upserted.** `src/settings/validate.ts:226`
   always `checks.create`s, so a re-delivered event can leave more than one run with
   the same name on a SHA (GitHub shows the latest; the gatekeeper's
   `filter: "latest"` hides it). Harmless today; recorded as an implementation
   detail, not a spec claim.
6. **Docs over-generalisation (doc-only, out of scope).** `docs/test-plan.md:19`
   says dry-run means "Every decision is evaluated and logged"; for config validation
   the verdict is evaluated but only the skip labels are logged (the spec's
   Requirement 5 was corrected). Follow-up is a docs wording change, not code.
7. **Non-removed rename reads as a change.** `src/settings/validate.ts:197` excludes
   only `removed`, so a renamed settings file is validated under its new path; the
   spec's "adds or modifies" reads slightly narrower. Left as-is (a rename into a
   settings path is effectively an add); not a gap.

### Candidate tests checked (per the brief)

`test/validate.test.ts` (path recognition, document validation, summarise,
buildComment), `test/paths.test.ts` (`isSettingsPath`), `test/comments.test.ts`
(`syncMarkerComment` mechanics), `test/dry-run.test.ts` (`performWrite` guard) and
`test/config.test.ts` (`parseConfig` schema rules) back the pure layers. No test
drives `validatePullRequest` or the `src/app.ts` config-validation listener.

## Installation-lockdown

Spec: `openspec/changes/backfill-capability-specs/specs/installation-lockdown/spec.md`.
Primary sources: `src/security/allowlist.ts` (`resolveOwner`, `Allowlist`,
`OwnerSource`, `AllowlistDecision`), `src/security/guard.ts` (`GuardedApp`,
`EventScope`), `src/apps/registry.ts` (`appDefinitionSchema`,
`loadAppDefinitions`, `resolveDefinitions`, `AppRegistry`), `src/lib/env.ts`
(`parseAllowedTargets`, `ConfigurationError`), and the startup exit
`src/server.ts:fatal` / `main` (32-71). No spec edits were needed — the spec
matches the implementation; the unresolvable-by-spec-text observations are
recorded under Gaps.

### Requirement: Every delivery passes the allowlist before any handler

- Source: `src/security/guard.ts:GuardedApp.on` (46-103) —
  `this.allowlist.check(context.payload)` runs before the wrapped handler and
  returns early on rejection (the D1 framing: an observable before-any-handler
  guarantee, not a code-structure rule).
- **Scenario "Event from a non-allowlisted account"** → `test/guard.test.ts >
  "GuardedApp" > "does not invoke the handler for a non-allowlisted owner"`;
  rejection path/log at `src/security/guard.ts:57-75`.
  **Gap — the logged rejection is untested**: the test's `fakeLogger` stubs
  `warn` but never asserts it was called.
- **Scenario "Owner unresolvable"** → `test/guard.test.ts > "GuardedApp" >
  "does not invoke the handler when the owner cannot be resolved"`;
  `test/allowlist.test.ts > "Allowlist" > "fails closed when the owner cannot be
  determined"`; source `src/security/allowlist.ts:Allowlist.check` (101-111).

### Requirement: Owner resolution falls back in order and never trusts the sender

- Source: `src/security/allowlist.ts:resolveOwner` (44-67) —
  `repository.owner.login` → `organization.login` → `installation.account.login`;
  there is no `sender` branch at all.
- **Scenario "Installation event without a repository"** →
  `test/allowlist.test.ts > "resolveOwner" > "falls back to the installation account"`
  (and `> "falls back to organization for events without a repository"`).
- **Scenario "Allowlisted sender, non-allowlisted repository"** →
  `test/allowlist.test.ts > "resolveOwner" > "never derives the owner from sender"`
  and `> "prefers repository.owner.login"`; `test/guard.test.ts > "GuardedApp" >
  "does not invoke the handler when the owner cannot be resolved"` (allowlisted
  sender, no nameable owner → rejected). The composition is covered **transitively**,
  not by one composed test — any sender consultation at any priority would fail
  `"never derives the owner from sender"`, and repository-owner preference is pinned
  by `"prefers repository.owner.login"`. Malformed payloads:
  `test/allowlist.test.ts > "resolveOwner" > "returns undefined for malformed payload %p"`
  and `> "ignores blank logins"`.

### Requirement: A boundaryless configuration refuses to start

- Source: `src/apps/registry.ts:resolveDefinitions` — empty App map (164-169),
  invalid/NaN `appId` (176-186), map key vs App ID (191-196), duplicate App ID
  (198-200), missing allowlist from both sources (207-217); `ConfigurationError`
  → `src/server.ts:fatal` (32-43, exit 78 / `EX_CONFIG`) via `main` (48-71).
- **Scenario "No allowlist anywhere"** → `test/registry.test.ts >
  "resolveDefinitions" > "refuses an App with no allowlist from either source"`
  and `> "resolveDefinitions — allowlist sources" > "names both remedies when an
  App has no allowlist"`; also `> "needs no global default when every App sets
  its own"` (the inverse).
- **Scenario "Map key disagrees with the App ID"** → `test/registry.test.ts >
  "resolveDefinitions" > "rejects a key that disagrees with its appId"`.
- Statement-only refusal with coverage: empty App map →
  `test/registry.test.ts > "resolveDefinitions" > "refuses an empty configuration"`.
  **Gap — the duplicate-App-ID refusal is untested** (`registry.ts:198-200`;
  reachable only via keys that differ solely by surrounding whitespace, since a
  passing entry must have `key.trim() === String(appId)`). **Gap — the
  `fatal`/exit-78 startup path and `AppRegistry.create` are untested**
  (`src/server.ts:32-43, 68-71`; `test/registry.test.ts` covers only
  `loadAppDefinitions` and `resolveDefinitions`).

### Requirement: The allowlist is exact and case-insensitive

- Source: `src/security/allowlist.ts:Allowlist` (77-111) — targets lowercased on
  construction (85) and on `has` (93) for case-insensitive exact `Set.has` (no
  substrings, `:92-94`); constructor throws on a zero-length target array
  (82-84). Wildcard rejection: `src/lib/env.ts:parseAllowedTargets` (74-81),
  reused by `src/apps/registry.ts:220`.
- **Scenario "Wildcard rejected"** → `test/env.test.ts > "parseAllowedTargets" >
  "refuses wildcard %p"` (covers `*`, `all`, `["*"]`, `me,*`) and
  `test/registry.test.ts > "resolveDefinitions" > "rejects a wildcard in a
  per-App allowlist"`.
- **Scenario "Case differences still match"** → `test/allowlist.test.ts >
  "Allowlist" > "matches case-insensitively"`; exactness pinned by
  `> "does not match on substrings"` and `> "refuses to construct empty"`.

### Gaps — follow-up material

1. **Duplicate-App-ID refusal is untested.** `src/apps/registry.ts:198-200`
   throws `Duplicate App ID ${appId}`, but no test drives it. It is reachable
   only through map keys that normalise to the same App ID but differ as strings
   (e.g. `" 123"` and `"123"`), which is why it is easy to miss.
2. **The startup exit path is untested.** `resolveDefinitions` throwing
   `ConfigurationError` is covered, but `src/server.ts:main` catching it and
   `fatal` exiting 78 (`src/server.ts:32-43`) is not, and neither is
   `AppRegistry.create`. The refusal semantics are tested; the process-exit
   consequence is not.
3. **The rejection log is untested.** `test/guard.test.ts` supplies a logger but
   only asserts the handler did not run; the `decision: "rejected"` warn with its
   `reason` (`src/security/guard.ts:62-74`) is source-only.
4. **Dead `sender` plumbing (code cleanliness, not a spec issue).**
   `OwnerSource` lists `"sender.login"` (`src/security/allowlist.ts:13`) and
   `MaybePayload` carries `sender` (`:24`), but `resolveOwner` never reads it, so
   the variant is unproducible; the comment at `:42` says sender "is resolved only
   so it can be logged on rejection", which is itself inaccurate — it is not
   resolved at all. Behaviour matches the spec ("never consults it"); the type
   and comment are stale.
5. **`new Allowlist([""])` / `new Allowlist(["  "])` is constructible.** The
   constructor only rejects a zero-*length* array (`src/security/allowlist.ts:82`),
   so a blanks-only list builds a degenerate allowlist whose sole entry is `""`.
   It is fail-closed: `resolveOwner`'s `asLogin` trims and rejects blank logins
   (`:27-29`), so no owner can ever be `""`, and `parseAllowedTargets` filters
   blanks before the registry constructs one. The spec's "empty allowlist SHALL
   NOT be constructible" holds for `[]`; the blanks variant is an untested edge,
   not a hole.
6. **"Every webhook delivery SHALL be checked" is literal only for events with a
   registered handler.** `GuardedApp` wraps registered listeners, so an event
   with no listener is never checked — vacuously safe, since no handler runs.
   The observable guarantee ("no handler runs without passing the boundary")
   holds; noted only so the requirement's wording is not read as a delivery-level
   hook.
7. **Boundary split with multi-app-operation (for the group-4 spec).**
   Installation-lockdown owns the *semantics* of the boundary-related startup
   refusals in `src/apps/registry.ts:resolveDefinitions` — empty App map, key-vs-App-ID
   mismatch, duplicate App ID, missing allowlist. The config-loading and App-shape
   failures from the same file (`loadAppDefinitions`: missing file, non-function
   export, schema validation) belong to the multi-app-operation capability. Recorded
   so group 4 specs them without re-speccing or contradicting these refusals.

### Candidate tests checked (per the brief)

`test/allowlist.test.ts` (`resolveOwner` order/sender/malformed payloads;
`Allowlist` case/exactness/empty), `test/guard.test.ts` (`GuardedApp`
allow/reject/rethrow), `test/registry.test.ts` (`loadAppDefinitions`,
`resolveDefinitions` refusals and allowlist sources) and `test/env.test.ts`
(`parseAllowedTargets` wildcard/empty rejection) back the boundary. There is no
test for `AppRegistry.create` or `src/server.ts`.

## Multi-app-operation

Spec: `openspec/changes/backfill-capability-specs/specs/multi-app-operation/spec.md`.
Primary sources: `src/server.ts` (`TARGET_ID_HEADER`, `TARGET_TYPE_HEADER`,
`MAX_PAYLOAD`, `fatal` 32-43, `main` 45-120, `handleWebhook` 122-197, `/healthz`
93-95); `src/apps/registry.ts` (`loadAppDefinitions` 75-143, `normalisePrivateKey`
234-244, `AppRegistry.create` 253-296); the operator-supplied
`config/apps.cjs` factory; `src/lib/env.ts:loadEnv`. One spec edit was needed —
Requirement 1 said per-App settings "override the global defaults", but there is
no global label default (it falls back to the App ID), so the sentence now lists
the settings as honoured with only the allowlist and baseline repo inheriting
global defaults.

### Boundary seam (D1) with installation-lockdown

Installation-lockdown (its Gaps item 7) owns the *semantics* of the
boundary-related startup refusals in `resolveDefinitions` — empty App map,
key-vs-App-ID mismatch, duplicate App ID, missing allowlist. This capability owns
the config-loading and App-shape failures from `loadAppDefinitions` (missing
file, non-function export, factory throw, schema validation), `normalisePrivateKey`
(non-PEM), the serving behaviour, and the **invalid/NaN `appId` refusal**
(`src/apps/registry.ts:176-186`) — which lockdown's spec deliberately does not
claim. No overlap or contradiction: Requirement 4 here owns the invalid-`appId`
refusal; lockdown owns the four boundary refusals.

### Requirement: Each App is served by its own Probot instance

- Source: `src/apps/registry.ts:AppRegistry.create` (253-296) — one
  `new Probot({ appId, privateKey, secret })` per App with `probot.load(createApp({...}))`,
  and a `"Registered GitHub App"` log per App (277-285); per-App resolution in
  `resolveDefinitions` (173-230).
- **Scenario "Two Apps, one container"** → `test/registry.test.ts >
  "loadAppDefinitions" > "supports several Apps with operator-chosen variable names"`
  and `> "resolveDefinitions" > "keeps Apps isolated from one another"`.
  **Gap — `AppRegistry.create` is untested**: nothing asserts two Probot
  instances, distinct per-App secrets, or the startup label log.
- **Scenario "Per-App allowlist overrides the default"** → `test/registry.test.ts >
  "resolveDefinitions" > "per-App allowlist overrides the global default"`,
  `> "resolveDefinitions — allowlist sources" > "falls back to the global default
  per App"` and `> "needs no global default when every App sets its own"`;
  baseline-repo override `> "per-App baselineRepo overrides the default"`; the
  default direction is pinned by `> "resolves a single App"` (a definition with no
  `baselineRepo` resolves to `.github-private`). The "every App ends up with an
  allowlist and a baseline repository either way" guarantee differs by mechanism:
  refusal-backed for the allowlist (`src/apps/registry.ts:207-217` throws), but
  env-default-backed for the baseline repo (`src/lib/env.ts:parseBaselineRepo` 91-97
  defaults to `.github-private`; no registry refusal).

### Requirement: Deliveries route by GitHub's App target header

- Source: `src/server.ts:handleWebhook` (122-167) — non-App target type → 400
  (141-148), unparseable target ID → 400 (150-155), `registry.get` miss → 404 +
  warning (157-167). Target header constant `:22`.
- **Scenario "Unknown App"** → `src/server.ts:157-167`. **Gap — no test**
  (`src/server.ts` has no test; manual walk `docs/test-plan.md` 7.4).
- **Scenario "Repository-level webhook"** → `src/server.ts:141-148`.
  **Gap — no test** (manual walk 7.3-7.5).

### Requirement: Routing precedes verification, and verification still binds

- Source: routing/selection (150-167) precedes `verifyAndReceive` (176-181), which
  uses the selected App's own secret from the Probot instance built with
  `entry.webhookSecret` (registry.ts:262-267); invalid signature → 400 (184-190);
  handler throw → 500 (193-196).
- **Scenario "Forged header, no matching signature"** → `src/server.ts:184-190`
  via the classifier `src/lib/webhook-errors.ts:isRequestRejection`,
  unit-tested by `test/webhook-errors.test.ts > "isRequestRejection" >
  "recognises a wrapped signature failure"` and `> "recognises a bare signature
  failure"`. **Gap — no test** drives `handleWebhook` end to end.
- **Scenario "Handler failure is surfaced"** → `src/server.ts:193-196`; the guard
  rethrow it relies on is `test/guard.test.ts > "GuardedApp" > "rethrows handler
  errors so the delivery is marked failed"`; the classifier's non-rejection case
  `test/webhook-errors.test.ts > "isRequestRejection" > "does not treat a handler
  failure as a rejection"`. **Gap — no test** asserts the 500 response itself.

### Requirement: App-configuration mistakes are fatal at boot

- Source: `src/apps/registry.ts:loadAppDefinitions` — missing file (86-92), ESM
  misuse (93-98), other load error (99-103), non-function export (110-115),
  factory throw (120-124), schema (126-140); `normalisePrivateKey` non-PEM
  (240-243); invalid `appId` in `resolveDefinitions` (176-186). Each throws
  `ConfigurationError`, which `src/server.ts:main` turns into `fatal` (exit 78).
- **Scenario "Unset environment variable"** → `test/registry.test.ts >
  "resolveDefinitions — unset environment variables" > "explains a NaN appId from
  parseInt of an unset variable"` and `> "survives the whole file evaluating to
  unset variables"`.
- **Scenario "Key is not a PEM"** → `test/registry.test.ts > "resolveDefinitions" >
  "rejects a private key that is not a PEM"` (base64 acceptance
  `> "accepts a base64 private key"`).
- Statement-only refusals with coverage: missing file → `test/registry.test.ts >
  "loadAppDefinitions" > "reports a missing file clearly"`; non-function export →
  `> "rejects a file that does not export a function"`; factory throw →
  `> "surfaces an error thrown by the config function"`; schema → `> "rejects
  unknown keys in an App definition"`. **Gap — the `fatal`/exit-78 termination is
  untested** (shared with Installation-lockdown Gaps item 2).

### Requirement: Health reports the served Apps

- Source: `src/server.ts:93-95` — `res.status(200).json({ status: "ok", apps: registry.size })`;
  `registry.size` is the registered-App count (`registry.ts:298-300`).
- **Scenario "Health check"** → `src/server.ts:93-95`. **Gap — no test**
  (manual walk `docs/test-plan.md` 7.1).

### Gaps — follow-up material

1. **Handler-thrown 400s misclassify as "invalid signature" (spec contradicted, wart).**
   A handler whose octokit call fails with a GitHub 400 (a `RequestError` carrying
   `.status: 400`) is rethrown by the guard on purpose (`src/security/guard.ts:100`,
   "so the delivery is marked failed"), `verifyAndReceive` rejects (possibly wrapping
   it in an AggregateError — the docstring at `src/lib/webhook-errors.ts:4-6`
   anticipates exactly that), and `handleWebhook`'s catch (`src/server.ts:183-190`)
   classifies it via `isRequestRejection`, whose bare `status === 400` check
   (`src/lib/webhook-errors.ts:20`) returns true for ANY status-carrying candidate
   with signature provenance unexamined. The delivery is therefore answered **400
   "invalid signature"** instead of the specced **500** — and GitHub does not
   redeliver a 400, so the handler's failed work is silently dropped: the exact
   outcome the spec's "SHALL produce a 500 so the delivery is marked failed and can
   be redelivered" exists to prevent. The spec deliberately keeps the designed 500
   contract (grace-0 / >1 MB precedent) rather than blessing the 400. Follow-up fix
   direction: require signature provenance in the classifier (match the "signature
   does not match" message, or confirm the 400 originated from `@octokit/webhooks`
   verification rather than any status-carrying error). Compounding it,
   `test/webhook-errors.test.ts:42-45` ("does not treat a GitHub 400 from our own API
   call as a rejection") passes `new Error("something broke")` — a fixture with NO
   `status` property — so the test name asserts behaviour it never verifies; the
   fixture should carry `status: 400` and still classify as non-rejection. Test-only
   follow-up material, not done here.
2. **Absent target-type header skips the non-App rejection.** `src/server.ts:141`
   reads `if (targetType !== undefined && targetType.toLowerCase() !== "integration")`,
   so a delivery with no `X-GitHub-Hook-Installation-Target-Type` header bypasses the
   400 and proceeds to routing, gated only by the signature. The specced scenario
   ("a delivery's target type is not a GitHub App" → 400) holds for explicit
   non-integration types; the blanket requirement wording ("deliveries that did not
   come from a GitHub App SHALL be rejected with 400") is implemented for explicit
   types only. Signature-gated, so not a hole, but the wording reads wider than the
   code.
3. **`MAX_PAYLOAD` comment contradicts its own cite (comment/code alignment).**
   `src/server.ts:25-30` claims the `10mb` cap is "well above anything GitHub sends"
   while itself citing GitHub's documented 25 MB ceiling, so a 10-25 MB delivery is
   rejected by `express.raw` with a 413 before `handleWebhook` runs. No spec claim
   exists (correctly); the follow-up is to reconcile the comment with the cap.
4. **`src/server.ts` has no test at all.** The unknown-App 404, the non-App /
   malformed-target 400s, the invalid-signature 400, the handler-failure 500 and
   `/healthz` are covered only by source and the manual `docs/test-plan.md`
   Phase 7 walk. `test/webhook-errors.test.ts` pins the rejection *classifier*,
   not the HTTP responses.
5. **`AppRegistry.create` is untested.** No assertion that two configured Apps
   yield two Probot instances with distinct secrets, that each gets the right
   `baselineRepo`/allowlist, or that the startup log lists both labels.
6. **The `fatal`/exit-78 termination is untested** for every boot-fatal case
   (same as Installation-lockdown Gaps item 2): the `ConfigurationError` throws
   are tested via `resolveDefinitions` / `loadAppDefinitions`, the process exit
   is not.
7. **Read-once tradeoff (accepted, not specced).** `TODO.md` "App configuration
   is read once at boot" — adding or changing a tenant requires a restart.
   Deliberately out of the spec per design D3.
8. **Per-App health is Post-1.0.** `TODO.md` records that `/healthz` reports how
   many Apps are served but not whether each authenticates; not part of the
   endpoint today.

### Candidate tests checked (per the brief)

`test/webhook-errors.test.ts` (rejection classifier), `test/registry.test.ts`
(`loadAppDefinitions` load/export/schema failures and `resolveDefinitions`
per-App overrides), `test/env.test.ts` (`loadEnv`, `APPS_CONFIG_PATH`) and
`test/config.test.ts` (schema) back the pieces. No test imports `src/server.ts`,
and none drives `AppRegistry.create`.
