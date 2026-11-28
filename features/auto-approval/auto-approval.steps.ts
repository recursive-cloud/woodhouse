import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { classifyActor, decide } from "../../src/approval/policy.js";
import type { ApprovalRequest } from "../../src/approval/policy.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import {
  ENABLED_BY_SELF,
  HEAD,
  RENOVATE,
  checksPass,
  graceElapsed,
  openPullRequest,
  parseConfig,
  readyForReview,
  requireAutoApprovalHarness,
  synchronize,
  withAllowedBot,
  world,
  type Harness,
} from "./auto-approval-world.js";
import {
  givenOwnerMyUser,
  givenRenovateBot,
  givenRenovateListed,
} from "../support/approval-givens.js";
import { installScenarioFakeClock, readCell } from "../support/scenario.js";

const feature = await loadFeature("features/auto-approval/auto-approval.feature");

function expectApproval(h: Harness | undefined): void {
  const evaluated = requireAutoApprovalHarness(h);
  expect(evaluated.createReview).toHaveBeenCalledOnce();
  expect(evaluated.createReview).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      event: "APPROVE",
      commit_id: HEAD,
    }),
  );
}

function expectNoReview(h: Harness | undefined): void {
  expect(requireAutoApprovalHarness(h).createReview).not.toHaveBeenCalled();
}

function submittedBody(h: Harness | undefined): string {
  const review = requireAutoApprovalHarness(h).submitted[0];
  if (review === undefined) {
    throw new Error("No review was submitted.");
  }
  return review.body;
}

describeFeature(feature, ({ ScenarioOutline, Scenario, BeforeEachScenario, AfterEachScenario }) => {
  // The fake clock must bracket a whole scenario: a per-step hook would
  // discard it between the step that schedules the grace re-check and the step
  // that fires it.
  installScenarioFakeClock({ BeforeEachScenario, AfterEachScenario });

  ScenarioOutline(`Owner-listed author`, ({ Given, When, Then, And }, variables) => {
    let config: AutoApprovalConfig | undefined;
    let request: ApprovalRequest | undefined;

    const requireStoredConfig = (): AutoApprovalConfig => {
      if (config === undefined) {
        throw new Error("The auto-approval configuration has not been built yet.");
      }
      return config;
    };
    const requireRequest = (): ApprovalRequest => {
      if (request === undefined) {
        throw new Error("The pull request has not been opened yet.");
      }
      return request;
    };

    Given(`auto-approval lists "My-User" as an owner`, () => {
      config = parseConfig({ owners: ["My-User"] });
    });
    When(`a pull request is opened by "<author>"`, () => {
      request = {
        author: readCell(variables, "author"),
        draft: false,
        state: "open",
        changedFiles: [],
        fileListTruncated: false,
        alreadyApproved: false,
      };
    });
    Then(`the author is classified as an owner`, () => {
      expect(classifyActor(requireRequest().author, requireStoredConfig())).toBe("owner");
    });
    And(`the decision approves it`, () => {
      expect(decide(requireRequest(), requireStoredConfig())).toEqual({ approve: true });
    });
  });

  ScenarioOutline(`Author in neither list`, ({ Given, When, Then, And }, variables) => {
    let config: AutoApprovalConfig | undefined;
    let request: ApprovalRequest | undefined;

    const requireStoredConfig = (): AutoApprovalConfig => {
      if (config === undefined) {
        throw new Error("The auto-approval configuration has not been built yet.");
      }
      return config;
    };
    const requireRequest = (): ApprovalRequest => {
      if (request === undefined) {
        throw new Error("The pull request has not been opened yet.");
      }
      return request;
    };

    Given(`auto-approval lists "My-User" as an owner`, () => {
      config = parseConfig({ owners: ["My-User"] });
    });
    And(`the Renovate bot as a bot`, () => {
      if (config === undefined) {
        throw new Error("The auto-approval configuration has not been built yet.");
      }
      config = withAllowedBot(config, RENOVATE);
    });
    When(`a pull request is opened by "<author>"`, () => {
      request = {
        author: readCell(variables, "author"),
        draft: false,
        state: "open",
        changedFiles: [],
        fileListTruncated: false,
        alreadyApproved: false,
      };
    });
    Then(`the author is classified as neither`, () => {
      expect(classifyActor(requireRequest().author, requireStoredConfig())).toBe("neither");
    });
    And(`the decision declines it`, () => {
      expect(decide(requireRequest(), requireStoredConfig()).approve).toBe(false);
    });
  });

  Scenario(`Approval waits for the checks to pass`, ({ Given, When, Then, And }) => {
    const w = world();

    givenOwnerMyUser({ Given }, w);
    When(`"my-user" opens a pull request while its checks fail`, async () => {
      w.fixture.checks = "failing";
      await openPullRequest(w, "my-user");
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness);
    });
    And(
      `when the checks pass Woodhouse submits an approval review pinned to the head commit`,
      async () => {
        await checksPass(w);
        expectApproval(w.harness);
      },
    );
  });

  Scenario(`Bot approval also waits for the checks to pass`, ({ Given, When, Then, And }) => {
    const w = world();

    givenRenovateBot({ Given, And }, w, () => {
      w.fixture.author = RENOVATE;
      w.fixture.autoMerge = ENABLED_BY_SELF;
    });
    When(`the bot opens a pull request while its checks fail`, async () => {
      w.fixture.checks = "failing";
      await openPullRequest(w, RENOVATE);
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness);
    });
    And(
      `when the checks pass Woodhouse submits an approval review pinned to the head commit`,
      async () => {
        await checksPass(w);
        expectApproval(w.harness);
      },
    );
  });

  Scenario(
    `A repository with no checks approves after the grace period`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenOwnerMyUser({ Given }, w);
      And(`the repository has no checks`, () => {
        w.fixture.checks = "none";
      });
      When(`"my-user" opens a pull request`, async () => {
        await openPullRequest(w, "my-user");
      });
      And(`the grace period elapses`, async () => {
        await graceElapsed(w);
      });
      Then(`Woodhouse submits an approval review`, () => {
        expectApproval(w.harness);
      });
    },
  );

  ScenarioOutline(
    `A refused pull request stays refused after the checks pass`,
    ({ Given, When, Then, And }, variables) => {
      const w = world();

      givenRenovateListed({ Given }, w);
      And(`<refusal>`, () => {
        // Every refusal phrase describes a fact about the bot's pull request.
        w.fixture.author = RENOVATE;
        const refusal = readCell(variables, "refusal");

        switch (refusal) {
          case "nobody has enabled auto-merge":
            w.fixture.autoMerge = null;
            return;
          case `"my-user" enabled auto-merge on the bot's pull request`:
            w.fixture.autoMerge = { enabled_by: { login: "my-user" } };
            return;
          case `the pull request modifies ".github/woodhouse.yml"`:
            w.fixture.autoMerge = ENABLED_BY_SELF;
            w.fixture.filePages = [[{ filename: ".github/woodhouse.yml", status: "modified" }]];
            return;
          default:
            throw new Error(`Unrecognised refusal phrase: ${JSON.stringify(refusal)}`);
        }
      });
      When(`the checks pass on the bot's pull request`, async () => {
        w.fixture.author = RENOVATE;
        await checksPass(w);
      });
      Then(`no review is submitted`, () => {
        expectNoReview(w.harness);
      });
    },
  );

  Scenario(
    `Synchronize re-approval waits for the new commit's checks`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenOwnerMyUser({ Given }, w);
      And(`Woodhouse approved an earlier commit of the pull request`, () => {
        w.fixture.reviews = [
          { state: "APPROVED", user: { login: "woodhouse[bot]" }, commit_id: "111111" },
        ];
      });
      When(`the author force-pushes a new head commit`, async () => {
        // The new head's CI has not concluded yet: approval must wait for it.
        w.fixture.author = "my-user";
        w.fixture.checks = "failing";
        await synchronize(w);
      });
      And(`the checks pass on the new commit`, async () => {
        await checksPass(w);
      });
      Then(`Woodhouse submits an approval review pinned to the new commit`, () => {
        expectApproval(w.harness);
      });
    },
  );

  Scenario(
    `A draft becoming ready is approved once its checks have passed`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenOwnerMyUser({ Given }, w);
      And(`the checks have passed on the draft's head commit`, () => {
        w.fixture.author = "my-user";
        w.fixture.draft = true;
        w.fixture.checks = "passed";
      });
      When(`the draft pull request becomes ready for review`, async () => {
        await readyForReview(w);
      });
      Then(`Woodhouse submits an approval review`, () => {
        expectApproval(w.harness);
      });
    },
  );

  Scenario(`No duplicate at the same commit`, ({ Given, When, Then, And }) => {
    const w = world();

    givenOwnerMyUser({ Given }, w);
    And(`Woodhouse already approved the head commit`, () => {
      w.fixture.author = "my-user";
      w.fixture.reviews = [
        { state: "APPROVED", user: { login: "woodhouse[bot]" }, commit_id: HEAD },
      ];
    });
    When(`the checks pass and the event re-delivers for the same commit`, async () => {
      await checksPass(w);
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness);
    });
  });

  Scenario(`Late toggle is fail-safe`, ({ Given, When, Then, And }) => {
    const w = world();

    givenRenovateListed({ Given }, w);
    When(`the bot opens a pull request and enables auto-merge shortly after`, async () => {
      w.fixture.checks = "failing";
      await openPullRequest(w, RENOVATE);
      // The bot toggles auto-merge a moment after opening.
      w.fixture.autoMerge = ENABLED_BY_SELF;
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness);
    });
    And(
      `when the checks pass Woodhouse submits an approval review pinned to the head commit`,
      async () => {
        await checksPass(w);
        expectApproval(w.harness);
      },
    );
  });

  Scenario(`Bot approval names its author`, ({ Given, When, Then, And }) => {
    const w = world();

    givenRenovateBot({ Given, And }, w, () => {
      w.fixture.author = RENOVATE;
      w.fixture.autoMerge = ENABLED_BY_SELF;
    });
    When(`the checks pass on the bot's pull request`, async () => {
      w.fixture.author = RENOVATE;
      await checksPass(w);
    });
    Then(`the review body names the bot as having asked to be merged`, () => {
      expect(submittedBody(w.harness)).toContain("renovate[bot] asked to be merged");
    });
    And(`the review body ends with the service sign-off`, () => {
      // The literal, so this cannot pass merely because a constant round-trips.
      expect(submittedBody(w.harness).endsWith("_Woodhouse, at your service._")).toBe(true);
    });
  });

  Scenario(`Dry-run approval`, ({ Given, When, Then, And }) => {
    const w = world();

    givenOwnerMyUser({ Given }, w);
    And(`dry-run mode is on`, () => {
      w.dryRun = true;
    });
    When(`the checks pass on the owner's pull request`, async () => {
      w.fixture.author = "my-user";
      await checksPass(w);
    });
    Then(`the approval decision is logged`, () => {
      // The approval's own label, not just any DRY_RUN line: the dry-run check
      // write logs one too, and this scenario is about the approval.
      expect(requireAutoApprovalHarness(w.harness).log.info).toHaveBeenCalledWith(
        expect.stringContaining("DRY_RUN: would approve pull request"),
      );
    });
    And(`GitHub receives no review`, () => {
      expectNoReview(w.harness);
    });
  });
});
