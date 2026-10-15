# Tasks

## 1. Schema typing: conditions, bypass enums, duplicate names (high-risk — validation boundary)

- [x] 1.1 Re-verify the bypass enums against the current REST reference (docs.github.com/en/rest/repos/rules — actor types and bypass modes) and record the confirmed lists in the change notes. Verify the recorded lists match the researcher's October 2026 findings or note the delta.
- [x] 1.2 Type `conditions` as strict `ref_name: { include, exclude }` and sync the `bypass_actors` enums (`User` actor type, `exempt` bypass mode) in `src/config/schema.ts`, updating the section's TSDoc to say why `rules` stays open. Verify with focused validation tests: ref_name accepted, organization-only condition key rejected with a path, `User`/`exempt` accepted.
- [x] 1.3 Add the duplicate-name refinement (case-insensitive, config-level) with tests: `main` + `MAIN` rejected naming the duplicate; distinct names pass. Verify with `npx vitest run test/config.test.ts`.
- [x] 1.4 Regenerate the schema and check for drift: `npm run schema:generate && npm run schema:check`. Verify `git diff schema/woodhouse.schema.json` shows the typed conditions and synced enums only.

## 2. Realistic ruleset fixtures (plan + apply passthrough fidelity)

- [x] 2.1 Add a plan test constructing a full ruleset — `required_status_checks` with parameters, `pull_request` with parameters, `ref_name` conditions, a bypass actor — asserting create/update/prune decisions and that the planned body preserves every rule parameter verbatim. Verify with `npx vitest run test/plan.test.ts`.
- [x] 2.2 Add an applier test driving the same fixture through POST/PUT/DELETE, asserting the request bodies carry the rules, conditions, and bypass verbatim. Verify with `npx vitest run test/appliers/rulesets.test.ts`.

## 3. Prune honesty and the realistic example

- [x] 3.1 Rewrite the `pruneRulesets` comment and description in `src/config/schema.ts` to state converge-everything semantics (deletes hand-made rulesets too; no ownership marker exists), and add the realistic ruleset example with the prune warning to `woodhouse.example.yml`. Verify with `npx vitest run test/example-config.test.ts`.
- [x] 3.2 Add a docs pointer for branch-protection users to GitHub's own "convert to ruleset" migration (no Woodhouse code). Verify the docs link renders in `README.md`.

## 4. Whole-change verification

- [x] 4.1 Run `npm test && npm run typecheck && npm run schema:check`.
- [x] 4.2 Run `mise run ci` (the full gate) and confirm the schema drift check is green after regeneration.
