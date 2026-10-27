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

  it("is exactly the modeline, its guidance, and settings.enabled", () => {
    const expected = `${SCHEMA_MODELINE}

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

    expect(ONBOARDING_TEMPLATE).toBe(expected);
  });

  it("parses as valid configuration through the runtime validator", () => {
    const result = parseConfig(yaml.load(ONBOARDING_TEMPLATE));

    if (!result.ok) console.error(result.issues);
    expect(result.ok).toBe(true);
  });

  it("carries only settings.enabled and nothing else", () => {
    // Starter config: every other section stays at its schema default.
    expect(yaml.load(ONBOARDING_TEMPLATE)).toEqual({ settings: { enabled: true } });
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

- It adds \`.github/woodhouse.yml\` with \`settings.enabled: true\`.
- Until it merges, Woodhouse writes nothing here — white-glove and configuration validation stay live, and they are what validated this very pull request.
- Merging switches management on, and the settings sync reports its work as a comment on this pull request.

## A note on baselines

Woodhouse has checked the owner-level \`.github-private\` configuration, and this repository is not yet managed there. A local file is how a repository records its own consent, and it overrides anything inherited.

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

  it("says the repository was resolved as not yet managed by the baseline", () => {
    // D4: an offer exists only because resolution said settings.enabled is not
    // true, so the body states the check happened rather than warning that the
    // repository may already be managed.
    expect(ONBOARDING_PR_BODY).toContain("owner-level `.github-private` configuration");
    expect(ONBOARDING_PR_BODY).toContain("not yet managed");
    expect(ONBOARDING_PR_BODY).toContain("records its own consent");
    expect(ONBOARDING_PR_BODY).not.toContain("may already inherit");
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

  it("skips a repository the resolved baseline already manages", () => {
    expect(shouldOnboard(repository, probe({ managed: true }))).toEqual({
      onboard: false,
      repository,
      reason: "baseline-managed",
    });
  });

  it("offers when the resolved baseline does not manage the repository", () => {
    expect(shouldOnboard(repository, probe({ managed: false }))).toEqual({
      onboard: true,
      repository,
      reason: "no-settings-file",
    });
  });

  it("treats an unset managed field as not managed", () => {
    // Call sites that predate the field leave it undefined; behavior is unchanged.
    const decision = shouldOnboard(repository, { configPresent: false, openOnboardingPr: false });
    expect(decision).toEqual({ onboard: true, repository, reason: "no-settings-file" });
  });

  it("skips a managed repository before the pull-request probe", () => {
    // A managed repository skips without paying for the PR search, so the field
    // is unprobed; the management skip must not fall through to fail-closed.
    const decision = shouldOnboard(repository, { configPresent: false, managed: true });
    expect(decision).toMatchObject({ onboard: false, reason: "baseline-managed" });
  });

  it("prefers the managed skip when an onboarding pull request is also open", () => {
    const decision = shouldOnboard(repository, probe({ managed: true, openOnboardingPr: true }));
    expect(decision).toMatchObject({ onboard: false, reason: "baseline-managed" });
  });

  it("prefers the settings-file skip over the managed skip", () => {
    const decision = shouldOnboard(repository, probe({ configPresent: true, managed: true }));
    expect(decision).toMatchObject({ onboard: false, reason: "settings-file-present" });
  });
});
