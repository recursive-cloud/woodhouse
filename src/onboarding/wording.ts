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
 * A repository's first configuration: the schema modeline, guidance pointing at
 * the schema and the example, and `settings.enabled: true`. Nothing else —
 * every other section stays at its schema default, so the file says only what
 * the operator must decide to opt in.
 */
export const ONBOARDING_TEMPLATE = `${SCHEMA_MODELINE}

# Woodhouse — starter configuration.
#
# This file switches settings management on for this repository. Merging the
# pull request that added it is the whole opt-in; until then Woodhouse writes
# nothing here.
#
# Everything not named below stays at its schema default. The schema is linked
# from the modeline above, and a fully commented example lives in the
# Woodhouse repository as \`woodhouse.example.yml\`.
#
# Edit freely: Woodhouse reads this file from the default branch whenever it
# changes, and reports what it did on the pull request.

settings:
  enabled: true
`;

/**
 * Body of the onboarding pull request. Butler register, like the approval
 * wording, and it ends with the shared sign-off.
 *
 * It has to answer three questions — what Woodhouse does, what merging this
 * enables, and how to edit it — and, because a repository with no local file
 * may still be covered by an owner-level baseline, it says so. A local file is
 * how a repository records its own consent and overrides the baseline.
 */
export const ONBOARDING_PR_BODY = `Woodhouse is installed, and this pull request is the invitation: merge it to hand management of this repository over.

Woodhouse keeps repository settings, labels, branch protection, rulesets and auto-approval in order, and consolidates every check into a single \`woodhouse/white-glove\` status. All of it is driven by configuration in the repository.

This pull request adds \`.github/woodhouse.yml\` with \`settings.enabled: true\`. Until it merges, Woodhouse writes nothing here: white-glove and configuration validation stay live, and they are what validated this very pull request. Merging switches management on, and the settings sync reports its work as a comment on this pull request.

A word to the wise: this repository may already inherit baseline settings from the owner-level \`.github-private\` configuration. A local file is how a repository records its own consent, and it overrides anything inherited.

Edit the file freely — anything you leave out stays at its schema default. The schema and a fully commented example are linked from the modeline at the top of the file.

${SIGN_OFF}`;
