# Tasks

## 1. Pure write decision helper

- [x] 1.1 Create `src/gatekeeper/write-decision.ts` exporting a pure `resolveCheckWrite(existing: { status: string } | undefined, outcome: "pending" | "success" | "failure"): "create" | "update"` implementing the matrix: undefined existing → create; existing not `completed` (`in_progress`, `queued`, any non-terminal status) → update; existing completed + terminal outcome → update; existing completed + pending outcome → create. Verify with a new hermetic `test/gatekeeper/write-decision.test.ts` covering all four branches including a `queued`-existing cell (`npx vitest run test/gatekeeper/write-decision.test.ts`)

## 2. Handler wiring and head_sha rider

- [ ] 2.1 Widen `findExisting` (`src/gatekeeper/handler.ts:130`) to return `{ id, status }` of the NEWEST same-name run for the ref, deterministically — latest attempt by `started_at` falling back to `id` asc (mirroring `evaluate.ts`'s latest-attempt dedupe) — breaking ties across suites, from a single `listForRef(check_name, filter: "latest", per_page: 100)` call. Rewrite `upsertCheck` to use `resolveCheckWrite`: on "create" call `octokit.checks.create` with `head_sha` and the full body; on "update" call `octokit.checks.update` with `check_run_id` and a body that omits `head_sha`. Log which path was taken. Verify typecheck: `npm run typecheck`
- [ ] 2.2 Add `test/gatekeeper/handler.test.ts` with a `build()` helper and `vi.fn()` octokit (mirroring `test/appliers/branch-protection.test.ts`) covering: pending-after-completed → `checks.create` called once with a body matching `objectContaining({ name: WHITE_GLOVE_CHECK_NAME, head_sha: sha, status: "in_progress" })` and no `checks.update` call; pending-after-pending → `checks.update` called and its body contains no `head_sha`; terminal-after-completed → `checks.update` called without `head_sha`; no existing run → `checks.create` called; two-same-name-runs fixture (old completed + newer `in_progress`) → the in_progress run is selected and updated in place; dry-run=true → no octokit writes. Verify: `npx vitest run test/gatekeeper/handler.test.ts`

## 3. Full verification

- [ ] 3.1 Run the full local gates: `hk check`, `npm run typecheck`, `npm test`, `npm run build` — all green with the new tests included
