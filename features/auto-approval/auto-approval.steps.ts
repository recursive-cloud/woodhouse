import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { classifyActor, decide } from "../../src/approval/policy.js";
import type { ApprovalRequest } from "../../src/approval/policy.js";
import { resetAppLoginCache } from "../../src/approval/silverPlatter.js";
import type { AutoApprovalConfig } from "../../src/config/schema.js";
import {
  ENABLED_BY_SELF,
  GRACE_MS,
  RENOVATE,
  cast,
  evaluate,
  harnessFor,
  parseConfig,
  requireAutoApprovalHarness,
  requireConfig,
  withAllowedBot,
  world,
  type Harness,
} from "./auto-approval-world.js";
import { readCell } from "../support/scenario.js";

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
      commit_id: "abc123",
    }),
  );
}

function expectNoReview(h: Harness | undefined, approved: boolean | undefined): void {
  expect(approved).toBe(false);
  expect(requireAutoApprovalHarness(h).createReview).not.toHaveBeenCalled();
}

function submittedBody(h: Harness | undefined): string {
  const review = requireAutoApprovalHarness(h).submitted[0];
  if (review === undefined) {
    throw new Error("No review was submitted.");
  }
  return review.body;
}

describeFeature(feature, ({ BeforeEachScenario, ScenarioOutline, Scenario }) => {
  // appLogin is cached per process; every scenario owns a fresh fake octokit.
  BeforeEachScenario(() => resetAppLoginCache());

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

  Scenario(`Owner pull request`, ({ Given, When, Then }) => {
    const w = world();

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
    When(`"my-user" opens a pull request touching no protected path`, async () => {
      await evaluate(w, { author: "my-user", action: "opened" });
    });
    Then(`Woodhouse submits an approval review`, () => {
      expectApproval(w.harness);
    });
  });

  Scenario(`Bot with its own auto-merge`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    And(`the bot enabled auto-merge itself`, () => {
      w.autoMerge = ENABLED_BY_SELF;
    });
    When(`the pull request is evaluated`, async () => {
      await evaluate(w, { author: RENOVATE, action: "synchronize" });
    });
    Then(`Woodhouse submits an approval review`, () => {
      expectApproval(w.harness);
    });
  });

  Scenario(`Bot without auto-merge`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    And(`nobody has enabled auto-merge`, () => {
      w.autoMerge = null;
    });
    When(`the pull request is evaluated`, async () => {
      await evaluate(w, { author: RENOVATE, action: "synchronize" });
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness, w.approved);
    });
  });

  Scenario(`Auto-merge enabled by someone else`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    And(`"my-user" enabled auto-merge on the bot's pull request`, () => {
      w.autoMerge = { enabled_by: { login: "my-user" } };
    });
    When(`the pull request is evaluated`, async () => {
      await evaluate(w, { author: RENOVATE, action: "synchronize" });
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness, w.approved);
    });
  });

  Scenario(`Late toggle is fail-safe`, ({ Given, When, Then, And }) => {
    const w = world();
    let openedHarness: Harness | undefined;
    let openedApproved: boolean | undefined;

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    When(`the bot opens a pull request and enables auto-merge shortly after`, async () => {
      vi.useFakeTimers();
      try {
        // The opened event races the bot's own toggle, so the live GET happens
        // only after the grace and still reports no auto-merge.
        const h = harnessFor(w);
        openedHarness = h;
        const pending = cast(h, requireConfig(w), { author: RENOVATE, action: "opened" });

        await vi.advanceTimersByTimeAsync(0);
        expect(h.get).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(GRACE_MS);
        openedApproved = await pending;
      } finally {
        vi.useRealTimers();
      }
    });
    Then(`the opened evaluation submits no review`, () => {
      expectNoReview(openedHarness, openedApproved);
    });
    And(`a later event re-evaluates the pull request with auto-merge enabled`, async () => {
      // A fresh harness: by the later event the bot has toggled auto-merge.
      w.autoMerge = ENABLED_BY_SELF;
      await evaluate(w, { author: RENOVATE, action: "synchronize" });
    });
    And(`that evaluation submits an approval review`, () => {
      expect(w.approved).toBe(true);
      const h = requireAutoApprovalHarness(w.harness);
      expect(h.createReview).toHaveBeenCalledOnce();
      expect(h.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: "APPROVE", commit_id: "abc123" }),
      );
    });
  });

  Scenario(`Bot widens the actor lists`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    And(`the bot enabled auto-merge itself`, () => {
      w.autoMerge = ENABLED_BY_SELF;
    });
    When(`the pull request modifies ".github/woodhouse.yml"`, async () => {
      w.files = [[{ filename: ".github/woodhouse.yml", status: "modified" }]];
      await evaluate(w, { author: RENOVATE, action: "synchronize" });
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness, w.approved);
    });
  });

  Scenario(`Draft becomes ready`, ({ Given, When, Then }) => {
    const w = world();

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
    When(`the draft pull request becomes ready for review`, async () => {
      // GitHub sends the post-ready payload, where draft is already false.
      await evaluate(w, { author: "my-user", action: "ready_for_review" });
    });
    Then(`Woodhouse submits an approval review`, () => {
      expectApproval(w.harness);
    });
  });

  Scenario(`Synchronize re-approval`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
    And(`Woodhouse approved an earlier commit of the pull request`, () => {
      w.reviews = [{ state: "APPROVED", user: { login: "woodhouse[bot]" }, commit_id: "111111" }];
    });
    When(`the author force-pushes a new head commit`, async () => {
      await evaluate(w, { author: "my-user", action: "synchronize", headSha: "abc123" });
    });
    Then(`Woodhouse submits an approval review pinned to the new commit`, () => {
      const h = requireAutoApprovalHarness(w.harness);
      expect(h.createReview).toHaveBeenCalledOnce();
      expect(h.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ event: "APPROVE", commit_id: "abc123" }),
      );
    });
  });

  Scenario(`No duplicate at the same commit`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
    And(`Woodhouse already approved the head commit`, () => {
      w.reviews = [{ state: "APPROVED", user: { login: "woodhouse[bot]" }, commit_id: "abc123" }];
    });
    When(`the event re-delivers for the same commit`, async () => {
      await evaluate(w, { author: "my-user", action: "synchronize", headSha: "abc123" });
    });
    Then(`no review is submitted`, () => {
      expectNoReview(w.harness, w.approved);
    });
  });

  Scenario(`Bot approval names its author`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    And(`the bot enabled auto-merge itself`, () => {
      w.autoMerge = ENABLED_BY_SELF;
    });
    When(`the pull request is approved`, async () => {
      await evaluate(w, { author: RENOVATE, action: "synchronize" });
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

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
    And(`dry-run mode is on`, () => {
      w.dryRun = true;
    });
    When(`the owner's pull request is evaluated`, async () => {
      await evaluate(w, { author: "my-user", action: "opened" });
    });
    Then(`the approval decision is logged`, () => {
      expect(requireAutoApprovalHarness(w.harness).log.info).toHaveBeenCalledWith(
        expect.stringContaining("DRY_RUN: would approve pull request"),
      );
    });
    And(`GitHub receives no review`, () => {
      expectNoReview(w.harness, w.approved);
    });
  });
});
