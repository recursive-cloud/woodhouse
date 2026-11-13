# 0005. Generated JSON Schema As the Config Contract

Status: Accepted (in force before 1.0; predates this directory)

## Context

Repos configure Woodhouse through YAML that people edit by hand. Editors can offer completions and validation only when a schema is published.

## Decision

`schema/woodhouse.schema.json` is generated from the zod definitions in `src/config/schema.ts` and is the single source of truth for the configuration contract. It is never hand-edited: `npm run schema:generate` regenerates it, and CI (`npm run schema:check`) fails on drift.

## Consequences

- One place to change the contract: the zod schema. Runtime validation and the published JSON Schema both follow from it.
- The published schema is the anchor for editor-side completions and validation, which the 1.x focus on config authoring builds on.
