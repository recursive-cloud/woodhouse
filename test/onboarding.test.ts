import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { SIGN_OFF } from "../src/approval/wording.js";
import { SCHEMA_MODELINE } from "../src/config/json-schema.js";
import { LOCAL_PATHS } from "../src/config/paths.js";
import { parseConfig } from "../src/config/schema.js";
import {
  shouldOnboard,
  type OnboardingRepository,
  type OnboardingProbe,
} from "../src/onboarding/decide.js";
import {
  ONBOARDING_BRANCH,
  ONBOARDING_FILE_PATH,
  ONBOARDING_LABEL,
  ONBOARDING_PR_BODY,
  ONBOARDING_PR_TITLE,
  ONBOARDING_TEMPLATE,
} from "../src/onboarding/wording.js";

describe("onboarding constants", () => {
  it("carries the exact branch, title, label and file path", () => {
    expect(ONBOARDING_BRANCH).toBe("woodhouse/onboarding");
    expect(ONBOARDING_PR_TITLE).toBe("chore: onboard to Woodhouse");
    expect(ONBOARDING_LABEL).toBe("woodhouse: onboarding");
    expect(ONBOARDING_FILE_PATH).toBe(".github/woodhouse.yml");
  });

  it("adds the local settings path the config checker already knows", () => {
    expect(ONBOARDING_FILE_PATH).toBe(LOCAL_PATHS[0]);
  });
});

describe("ONBOARDING_TEMPLATE", () => {
  it("starts with the schema modeline", () => {
    expect(ONBOARDING_TEMPLATE.startsWith(SCHEMA_MODELINE)).toBe(true);
  });

  it("is exactly the modeline and its guidance", () => {
    const expected = `${SCHEMA_MODELINE}

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

    expect(ONBOARDING_TEMPLATE).toBe(expected);
  });

  it("parses as valid configuration through the runtime validator", () => {
    const result = parseConfig(yaml.load(ONBOARDING_TEMPLATE));

    if (!result.ok) console.error(result.issues);
    expect(result.ok).toBe(true);
  });

  it("carries no configuration keys at all", () => {
    // File presence is the opt-in; `settings.enabled` defaults on, so the
    // starter file needs no settings section.
    expect(yaml.load(ONBOARDING_TEMPLATE)).toBeNull();
  });

  it("points at the schema and the example", () => {
    expect(ONBOARDING_TEMPLATE).toContain(SCHEMA_MODELINE);
    expect(ONBOARDING_TEMPLATE).toContain("woodhouse.example.yml");
  });
});

describe("ONBOARDING_PR_BODY", () => {
  it("is exactly the butler-register body, ending with the service sign-off", () => {
    const expected = `## An invitation

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

    expect(ONBOARDING_PR_BODY).toBe(expected);
    expect(ONBOARDING_PR_BODY.endsWith(SIGN_OFF)).toBe(true);
  });

  it("is broken into scannable markdown sections", () => {
    expect(ONBOARDING_PR_BODY).toMatch(/^## /m);
    expect(ONBOARDING_PR_BODY).toMatch(/^- /m);
  });

  it("explains that the local file records consent and inherits the baseline", () => {
    expect(ONBOARDING_PR_BODY).toContain("owner-level `.github-private` configuration");
    expect(ONBOARDING_PR_BODY).toContain("inherited and merged");
    expect(ONBOARDING_PR_BODY).toContain("records its own consent");
    // No management check happens, so the body must not claim one did.
    expect(ONBOARDING_PR_BODY).not.toContain("not yet managed");
    expect(ONBOARDING_PR_BODY).not.toContain("has checked");
  });
});

const repository: OnboardingRepository = { owner: "recursive-cloud", name: "woodhouse" };

const probe = (o: Partial<OnboardingProbe> = {}): OnboardingProbe => ({
  configPresent: false,
  openOnboardingPr: false,
  ...o,
});

describe("shouldOnboard", () => {
  it("offers when there is no settings file and no open pull request", () => {
    expect(shouldOnboard(repository, probe())).toEqual({
      onboard: true,
      repository,
      reason: "no-settings-file",
    });
  });

  it("skips whenever a settings file is present", () => {
    const decision = shouldOnboard(repository, probe({ configPresent: true }));
    expect(decision).toMatchObject({ onboard: false, reason: "settings-file-present" });
  });

  it("skips when an onboarding pull request is already open", () => {
    expect(shouldOnboard(repository, probe({ openOnboardingPr: true }))).toEqual({
      onboard: false,
      repository,
      reason: "onboarding-pull-request-open",
    });
  });

  it("short-circuits on config before the pull-request probe", () => {
    // The probe never ran, so the field is unprobed; config-present must still
    // skip, without touching the pull-request state.
    const decision = shouldOnboard(repository, { configPresent: true });
    expect(decision).toMatchObject({ onboard: false, reason: "settings-file-present" });
  });

  it("prefers the settings-file skip when both signs are present", () => {
    const decision = shouldOnboard(
      repository,
      probe({ configPresent: true, openOnboardingPr: true }),
    );
    expect(decision).toMatchObject({ onboard: false, reason: "settings-file-present" });
  });

  it("fails closed when the pull-request state was never probed and no settings file exists", () => {
    // Cannot confirm no offer exists; a duplicate is worse than no offer.
    const decision = shouldOnboard(repository, { configPresent: false });
    expect(decision).toMatchObject({ onboard: false, reason: "pull-request-state-unprobed" });
  });
});
