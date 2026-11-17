/**
 * Onboarding constants — the branch, the label, the pull-request title and
 * body, and the starter configuration file.
 *
 * Pure strings kept out of the API-calling module so the exact wording is
 * directly testable, the same register as `approval/wording.ts`. The starter
 * configuration is authored as one constant and asserted to parse through the
 * runtime validator, so a schema change that invalidated it would fail a test
 * rather than ship a pull request the config check then rejects.
 */

import { SIGN_OFF } from "../approval/wording.js";
import { SCHEMA_MODELINE } from "../config/json-schema.js";

/** Branch the onboarding pull request is opened from. */
export const ONBOARDING_BRANCH = "woodhouse/onboarding";

/** Conventional title, so a repository's own history stays conventional-friendly. */
export const ONBOARDING_PR_TITLE = "chore: onboard to Woodhouse";

/**
 * The label marking an onboarding pull request — the idempotency marker the
 * probe searches for, by label plus head branch.
 */
export const ONBOARDING_LABEL = "woodhouse: onboarding";

/** The file the pull request adds. */
export const ONBOARDING_FILE_PATH = ".github/woodhouse.yml";

/**
 * The starter configuration.
 *
 * A repository's first configuration: the schema modeline and guidance
 * pointing at the schema and the example. No settings section at all — the
 * file's presence is the opt-in signal, and `settings.enabled` defaults on, so
 * naming it would add nothing the schema does not already say.
 */
export const ONBOARDING_TEMPLATE = `${SCHEMA_MODELINE}

# Woodhouse — starter configuration.
#
# This file is how a repository opts into settings management: its presence on
# the default branch is the consent signal, and merging the pull request that
# added it is the whole opt-in. Until then Woodhouse writes no settings here.
#
# Everything stays at its schema default. The schema is linked from the
# modeline above, and a fully commented example lives in the Woodhouse
# repository as \`woodhouse.example.yml\`.
#
# \`settings.enabled\` is a kill switch that defaults to on. Set it to \`false\`
# to silence settings sync for this repository.
#
# Edit freely: Woodhouse reads this file from the default branch whenever it
# changes, and reports what it did on the pull request.
`;

/**
 * Body of the onboarding pull request. Butler register, like the approval
 * wording, and it ends with the shared sign-off.
 *
 * It has to answer three questions — what Woodhouse does, what merging this
 * enables, and how to edit it — and it explains that a local file is how a
 * repository records its own consent while inheriting the owner baseline.
 */
export const ONBOARDING_PR_BODY = `## An invitation

Woodhouse is installed, and this pull request is the invitation: merge it to hand management of this repository over.

## What Woodhouse does

Woodhouse keeps repository settings, labels, branch protection, rulesets and auto-approval in order, and consolidates every check into a single \`woodhouse/white-glove\` status. All of it is driven by configuration in the repository.

## What this pull request means

- It adds \`.github/woodhouse.yml\`.
- Until it merges, Woodhouse writes no settings here — white-glove and configuration validation stay live, and they are what validated this very pull request.
- Merging opts this repository in, and the settings sync reports its work as a comment on this pull request.

## A note on baselines

The owner-level \`.github-private\` configuration is inherited and merged underneath this repository's file. A local file is how the repository records its own consent, and anything it sets overrides what it inherits.

## Editing the file

Edit the file freely — anything you leave out stays at its schema default. The schema and a fully commented example are linked from the modeline at the top of the file.

${SIGN_OFF}`;
