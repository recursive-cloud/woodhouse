import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { CONFIG_CHECK_NAME, RESOLVED_CONFIGURATION_PATH } from "../../src/settings/validate.js";
import {
  change,
  newScenario,
  runValidation,
  setBaseline,
  LOCAL_PATH,
  type Capture,
} from "../config/validation-world.js";
import { readCell } from "../support/scenario.js";

const feature = await loadFeature("features/dress-code/config.feature");

interface IssueExpectation {
  readonly path: string;
  /** A phrase only the issue for this field carries. */
  readonly fragment: string;
}

interface CouplingExpectation {
  readonly source: string;
  readonly issues: readonly IssueExpectation[];
}

const SQUASH_ALLOWED: IssueExpectation = {
  path: "repository.allow_squash_merge",
  fragment: "requires `allow_squash_merge: true`",
};
const SQUASH_TITLE: IssueExpectation = {
  path: "repository.squash_merge_commit_title",
  fragment: "requires `squash_merge_commit_title: PR_TITLE`",
};
const REBASE_DISALLOWED: IssueExpectation = {
  path: "repository.allow_rebase_merge",
  fragment: "requires `allow_rebase_merge: false`",
};
const MERGE_COMMIT_DISALLOWED: IssueExpectation = {
  path: "repository.allow_merge_commit",
  fragment: "requires `allow_merge_commit: false`",
};

const ALL_COUPLING = [SQUASH_ALLOWED, SQUASH_TITLE, REBASE_DISALLOWED, MERGE_COMMIT_DISALLOWED];

/** Merge settings dress-code requires, declared in full. */
const COUPLED_SOURCE = `dressCode:
  enabled: true
repository:
  allow_squash_merge: true
  squash_merge_commit_title: PR_TITLE
  allow_rebase_merge: false
  allow_merge_commit: false
`;

/** The success scenario's settings phrase, shared by its step text and the mapping. */
const COUPLED_CONTENTS =
  "with dressCode enabled, squash merges carrying the PR title, and rebase and merge-commit merges disallowed";

/**
 * Map a `<contents>` cell to the settings document it names and the coupling
 * issues that document must produce. The phrases are fixed by the feature; an
 * unrecognised one is a broken scenario, so this throws instead of returning a
 * document that might pass.
 */
function parseCouplingContents(cell: string): CouplingExpectation {
  switch (cell.trim()) {
    case "with dressCode enabled and rebase merges allowed":
      return {
        source: `dressCode:
  enabled: true
repository:
  allow_rebase_merge: true
`,
        issues: ALL_COUPLING,
      };
    case "with dressCode enabled and merge commits allowed":
      return {
        source: `dressCode:
  enabled: true
repository:
  allow_merge_commit: true
`,
        issues: ALL_COUPLING,
      };
    case "with dressCode enabled and no merge settings declared":
      return {
        source: `dressCode:
  enabled: true
`,
        issues: ALL_COUPLING,
      };
    case "with dressCode enabled and squash merges carrying the commit message":
      return {
        source: `dressCode:
  enabled: true
repository:
  allow_squash_merge: true
  squash_merge_commit_title: COMMIT_OR_PR_TITLE
  allow_rebase_merge: false
  allow_merge_commit: false
`,
        issues: [SQUASH_TITLE],
      };
    case COUPLED_CONTENTS:
      return { source: COUPLED_SOURCE, issues: [] };
    default:
      throw new Error(`Unrecognised dress-code settings phrase: ${JSON.stringify(cell)}`);
  }
}

interface CheckRunParams {
  readonly name?: string;
  readonly conclusion?: string;
  readonly output?: { readonly title?: string; readonly summary?: string };
}

function requireSummary(capture: Capture | undefined): string {
  if (capture === undefined) throw new Error("The configuration validation has not run yet.");
  const params = (
    capture.createCheck.mock.calls[0] as unknown as [CheckRunParams] | undefined
  )?.[0];
  const summary = params?.output?.summary;
  if (summary === undefined) throw new Error("The check run has no output summary.");
  return summary;
}

function expectFailure(capture: Capture | undefined, expected: readonly IssueExpectation[]): void {
  if (capture === undefined) throw new Error("The configuration validation has not run yet.");
  expect(capture.createCheck).toHaveBeenCalledOnce();
  expect(capture.createCheck).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: "acme",
      repo: "widgets",
      name: CONFIG_CHECK_NAME,
      conclusion: "failure",
    }),
  );

  const summary = requireSummary(capture);
  expect(summary).toContain(RESOLVED_CONFIGURATION_PATH);
  for (const issue of expected) {
    expect(summary).toContain(`\`${issue.path}\``);
    expect(summary).toContain(issue.fragment);
  }
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  ScenarioOutline(
    `Enabling dress-code without coupled merge settings fails validation`,
    ({ Given, When, Then }, variables) => {
      const state = newScenario();
      let capture: Capture | undefined;
      let expected: CouplingExpectation | undefined;

      Given(`a pull request changing a settings file <contents>`, () => {
        expected = parseCouplingContents(readCell(variables, "contents"));
        change(state, LOCAL_PATH, expected.source);
      });
      When(`the configuration validation runs`, async () => {
        capture = await runValidation(state);
      });
      Then(`the "woodhouse/config" check reports failure with the issue paths and messages`, () => {
        if (expected === undefined) {
          throw new Error("The settings-file contents have not been set yet.");
        }
        expectFailure(capture, expected.issues);
      });
    },
  );

  Scenario(
    `A repository file cannot undo the baseline's coupling`,
    ({ Given, And, When, Then }) => {
      const state = newScenario();
      let capture: Capture | undefined;

      Given(`the baseline config enables dress-code with coupled merge settings`, () => {
        setBaseline(state, "woodhouse.yml", COUPLED_SOURCE);
      });
      And(`a pull request changing the repository settings file to allow rebase merges`, () => {
        change(state, LOCAL_PATH, "repository:\n  allow_rebase_merge: true\n");
      });
      When(`the configuration validation runs`, async () => {
        capture = await runValidation(state);
      });
      Then(`the "woodhouse/config" check reports failure with the issue paths and messages`, () => {
        expectFailure(capture, [REBASE_DISALLOWED]);

        // The other three settings still come from the baseline, so the local
        // override must not turn them into extra failures.
        const summary = requireSummary(capture);
        expect(summary).not.toContain("`repository.allow_squash_merge`");
        expect(summary).not.toContain("`repository.squash_merge_commit_title`");
        expect(summary).not.toContain("`repository.allow_merge_commit`");
      });
    },
  );

  Scenario(`Explicitly coupled merge settings validate`, ({ Given, When, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request changing a settings file ${COUPLED_CONTENTS}`, () => {
      change(state, LOCAL_PATH, parseCouplingContents(COUPLED_CONTENTS).source);
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`the "woodhouse/config" check reports success`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.createCheck).toHaveBeenCalledOnce();
      expect(capture.createCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "acme",
          repo: "widgets",
          name: CONFIG_CHECK_NAME,
          conclusion: "success",
        }),
      );
      expect(requireSummary(capture)).not.toContain("dress-code requires");
    });
  });
});
