# Tasks

## 1. Probe: descriptions through prefault wrappers, title from meta

- [ ] 1.1 Add a probe test asserting a `.describe()`d field inside a `.prefault({})`-wrapped section emits its `description` through `z.toJSONSchema`, and record whether `.meta({ title })` emits `title`. If descriptions do not survive, establish the working pattern (describe before wrap, or after) in the same probe. Verify with `npx vitest run` on the new probe test.

## 2. The descriptions pass

- [ ] 2.1 Move the TSDoc prose into `.describe()` for the gatekeeper, autoApproval, settings, repository, branchProtection, labels, and root sections, shrinking comments per design D4. Verify with `npm run schema:generate && npm run schema:check` and a `git diff` of the schema showing descriptions appearing per section.
- [ ] 2.2 Write the rulesets documentation: description listing supported rule types as prose (open core), the `ref_name` condition shape, the bypass actor shape, the prune warning; add `.meta({ examples })` for `rulesets`, `strictChecks`, and `protectedPaths`. Verify the parity suite stays green: `npx vitest run test/json-schema.test.ts`.
- [ ] 2.3 Run `npm test && npm run typecheck` — no validation behavior changed.

## 3. Whole-change verification

- [ ] 3.1 Run `mise run ci && npm run schema:check` (full gate including drift after regeneration).
- [ ] 3.2 Record the probe answers (title emission, wrapper survival) in the change notes for the TODO's two named checks. Verify the notes state both answers explicitly.
