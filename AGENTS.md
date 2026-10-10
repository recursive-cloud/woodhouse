# Woodhouse
Self-hosted GitHub App (Probot as a library): cascading settings sync, PR auto-approval, and the `woodhouse/white-glove` consolidated check. Private homelab, not multi-tenant.
Sensitivity: private

## Commands
- toolchain: `mise install` (Node 22, hk, pkl) then `mise run install` — `npm ci` and the git hooks
- test: `npm test` (single file: `npx vitest run test/policy.test.ts`; hermetic unit tests — no env, network or docker)
- lint (report only): `mise run lint` (= `hk check`: oxlint + oxfmt) · fix: `mise run fix` · `npm run lint` alone is oxlint only — misses formatting
- typecheck: `npm run typecheck` · build: `npm run build` · everything CI runs: `mise run ci`
- regenerate the committed JSON Schema: `npm run schema:generate` — after any change to `src/config/schema.ts`, then commit

## Architecture
- `src/server.ts` — headless Express webhook server; routes each delivery by the `X-GitHub-Hook-Installation-Target-ID` header to that App's Probot instance before signature verification. Probot's `run()` helper is not used.
- `src/app.ts` — the per-App Probot app function; registers the guarded handlers (settings-sync, white-glove, silver-platter, config-validation)
- `src/apps/registry.ts` — loads App definitions from `config/apps.cjs` (map key must be the App ID; a mismatch is a startup error, not silently dropped webhooks), one Probot instance per App
- `src/security/` allowlist + `GuardedApp` · `src/gatekeeper/` white-glove verdict + check management · `src/settings/` plan/apply/validate · `src/approval/` auto-approval · `src/config/` zod schema, cascading resolver (objects merge, arrays replace), JSON Schema generation · `src/lib/` env, logger, cache, mutex, scheduler
- Decision logic is deliberately pure, separated from API calls: `gatekeeper/evaluate.ts`, `settings/plan.ts`, `approval/policy.ts` are plain functions over plain data and hold the bulk of the test suite — put new decision logic there, tested the same way.

## Rules
- Every webhook listener is registered through `GuardedApp` (`src/security/guard.ts`), never directly on the Probot instance — direct registration bypasses the installation allowlist.
- `schema/woodhouse.schema.json` is generated from the zod definitions in `src/config/schema.ts`. Never hand-edit; regenerate and commit. CI (`npm run schema:check`) fails on drift.
- `npm run typecheck` covers `src/` only — `tsconfig.json` excludes `test/`; test-file type errors surface in vitest, not tsc.
- `config/apps.cjs` is CommonJS deliberately: operator-supplied code loaded from disk (override with `APPS_CONFIG_PATH`). Don't convert it to ESM.
- Single replica only: per-commit work is serialised by the in-process mutex (`src/lib/mutex.ts`); the k8s Deployment uses `strategy: Recreate`. Multi-replica needs Redis first.
- Fails closed everywhere: unknown config keys rejected, unrecognised check conclusions fail, an App with no allowlist is a startup error (exit 78). Never add a wildcard or a silent fallback.
- The hk pre-commit hook fixes formatting (oxfmt + oxlint) and deliberately runs nothing slower — tests and typecheck are CI's job. `HK=0 git commit` skips it.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, …) — release-please will derive the changelog from them.
- Running the server needs `.env` credentials (`.env.example`); `DRY_RUN=true` evaluates and logs every decision without writing to GitHub — `docs/test-plan.md` walks through validating an install end to end.
- `TODO.md` is the live backlog — its "Accepted tradeoffs" section exists so they aren't rediscovered as bugs; read it before "fixing" one.
