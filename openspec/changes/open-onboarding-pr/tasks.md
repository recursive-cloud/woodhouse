# Tasks

## 1. Pure decision logic and template

- [ ] 1.1 Add the onboarding template constant (modeline, `settings.enabled: true`, schema/example pointers) and a test asserting it parses as valid configuration through the runtime validator. Verify with `npx vitest run` on the new test.
- [ ] 1.2 Implement `shouldOnboard` as a pure function over the event payload and probed repository state (local config present → skip; open onboarding PR → skip; else offer), with unit tests for every skip path and the offer path. Verify with the same focused vitest run.

## 2. Git-write seam behind dry-run (high-risk — authenticated repository writes)

- [ ] 2.1 Wrap the three net-new octokit calls — branch ref creation, file commit, pull request creation — in a small `src/onboarding/` module with every call behind `performWrite`, with its tests in `test/onboarding-write.test.ts`. Verify with `npx vitest run test/onboarding-write.test.ts`: full flow issues ref → contents → pull request in order; dry-run issues zero calls and logs the would-be PR (branch, file, title, body).
- [ ] 2.2 Cover the branch-exists-but-no-open-PR path: open a pull request from the existing branch without rewriting it. Verify with `npx vitest run test/onboarding-write.test.ts` asserting no ref or contents call is made on that path.

## 3. Handler wiring and idempotency

- [ ] 3.1 Register `installation` (created) and `installation_repositories` (added) through the guard in `src/app.ts`, forwarding to the handler; resolve the repository list from the payload per design D1. Verify with `npm test && npm run typecheck`.
- [ ] 3.2 Add handler tests on a fake octokit: fresh install opens the PR; already-configured repository is skipped silently; re-delivery while the PR is open skips; a repository added to an existing installation gets the offer. Verify with `npx vitest run` on the handler test file.

## 4. Docs and whole-change verification

- [ ] 4.1 Document the installation walk in `README.md` and add the onboarding steps to `docs/test-plan.md` (including the dry-run observation). Verify `npm test` still passes (config docs tests stay consistent).
- [ ] 4.2 Run `mise run ci && npm run schema:check` (full gate).

## Workflow follow-up

- After this change and the round's others are applied and verified, the 1.0 release pull request accumulates them; merging it cuts 1.0.0.
