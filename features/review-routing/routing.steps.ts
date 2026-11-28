import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { resetAppLoginCache } from "../../src/github/app-login.js";
import {
  givenOwnerMyUser,
  givenRenovateBot,
  givenRenovateListed,
} from "../support/approval-givens.js";
import {
  DEPENDABOT,
  ENABLED_BY_SELF,
  RENOVATE,
  checkRunFails,
  checkRunPasses,
  expectApproved,
  expectNoWrites,
  expectRemoved,
  expectRequested,
  expectRequestedOnce,
  parseConfig,
  requireConfig,
  routeOnce,
  withOwner,
  world,
} from "./routing-world.js";

const feature = await loadFeature("features/review-routing/routing.feature");

describeFeature(feature, ({ BeforeEachScenario, Scenario }) => {
  // The App login is cached per process; every scenario owns a fresh fake
  // octokit, so the cache may not leak into the next one.
  BeforeEachScenario(() => {
    resetAppLoginCache();
  });

  Scenario(`Owner pull request routes Woodhouse as reviewer`, ({ Given, When, Then }) => {
    const w = world();

    givenOwnerMyUser({ Given }, w);
    When(`"my-user" opens a pull request`, async () => {
      await routeOnce(w, { author: "my-user", action: "opened" });
    });
    Then(`Woodhouse is requested as the reviewer`, () => {
      expectRequested(w, ["woodhouse[bot]"]);
    });
  });

  Scenario(
    `Bot pull request with its own auto-merge routes Woodhouse as reviewer`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenRenovateBot({ Given, And }, w, () => {
        w.autoMerge = ENABLED_BY_SELF;
      });
      When(`the bot opens a pull request`, async () => {
        await routeOnce(w, { author: RENOVATE, action: "opened" });
      });
      Then(`Woodhouse is requested as the reviewer`, () => {
        expectRequested(w, ["woodhouse[bot]"]);
      });
    },
  );

  Scenario(
    `Bot pull request without auto-merge routes the owner as reviewer`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenRenovateListed({ Given }, w);
      And(`auto-approval lists "my-user" as an owner`, () => {
        w.config = withOwner(requireConfig(w), "my-user");
      });
      And(`nobody has enabled auto-merge`, () => {
        w.autoMerge = null;
      });
      When(`the bot opens a pull request`, async () => {
        await routeOnce(w, { author: RENOVATE, action: "opened" });
      });
      Then(`the owner "my-user" is requested as the reviewer`, () => {
        expectRequested(w, ["my-user"]);
      });
    },
  );

  Scenario(
    `Author outside both lists routes the owner as reviewer`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenRenovateListed({ Given }, w);
      And(`auto-approval lists "my-user" as an owner`, () => {
        w.config = withOwner(requireConfig(w), "my-user");
      });
      When(`"dependabot[bot]" opens a pull request`, async () => {
        await routeOnce(w, { author: DEPENDABOT, action: "opened" });
      });
      Then(`the owner "my-user" is requested as the reviewer`, () => {
        expectRequested(w, ["my-user"]);
      });
    },
  );

  Scenario(`Draft pull request gets no reviewer`, ({ Given, When, Then }) => {
    const w = world();

    givenOwnerMyUser({ Given }, w);
    When(`"my-user" opens a draft pull request`, async () => {
      // The opened payload reports the pull request as a draft.
      await routeOnce(w, { author: "my-user", action: "opened", draft: true });
    });
    Then(`no reviewer is requested`, () => {
      expectNoWrites(w);
    });
  });

  Scenario(`Draft becoming ready is routed`, ({ Given, When, Then, And }) => {
    const w = world();

    givenOwnerMyUser({ Given }, w);
    And(`"my-user" opened a draft pull request`, async () => {
      await routeOnce(w, { author: "my-user", action: "opened", draft: true });
    });
    When(`the pull request becomes ready for review`, async () => {
      // GitHub sends the post-ready payload, where draft is already false.
      await routeOnce(w, { author: "my-user", action: "ready_for_review" });
    });
    Then(`Woodhouse is requested as the reviewer`, () => {
      expectRequested(w, ["woodhouse[bot]"]);
    });
  });

  Scenario(`Late auto-merge toggle re-routes to Woodhouse`, ({ Given, When, Then, And }) => {
    const w = world();

    givenRenovateListed({ Given }, w);
    And(`auto-approval lists "my-user" as an owner`, () => {
      w.config = withOwner(requireConfig(w), "my-user");
    });
    And(`nobody has enabled auto-merge`, () => {
      w.autoMerge = null;
    });
    When(`the bot opens a pull request and enables auto-merge shortly after`, async () => {
      // The opened event races the bot's own toggle, so the live GET happens
      // only after the grace and still reports no auto-merge.
      await routeOnce(w, { author: RENOVATE, action: "opened" });
    });
    Then(`the opened routing requests the owner "my-user"`, () => {
      expectRequested(w, ["my-user"]);
    });
    And(`a later push to the pull request re-routes it to Woodhouse`, async () => {
      w.autoMerge = ENABLED_BY_SELF;
      await routeOnce(w, { author: RENOVATE, action: "synchronize" });
      expectRequested(w, ["woodhouse[bot]"]);
    });
  });

  Scenario(`Re-routing withdraws the previous reviewer`, ({ Given, When, Then, And }) => {
    const w = world();

    givenRenovateListed({ Given }, w);
    And(`auto-approval lists "my-user" as an owner`, () => {
      w.config = withOwner(requireConfig(w), "my-user");
    });
    And(`the owner "my-user" is requested as the reviewer on the bot's pull request`, async () => {
      // REC-45's duplicate scenario has no list-Givens; the REC-43 scenario sets
      // its config in earlier steps, so this default only fills an empty world.
      w.config ??= parseConfig({ bots: [RENOVATE], owners: ["my-user"] });
      await routeOnce(w, { author: RENOVATE, action: "opened" });
      expectRequested(w, ["my-user"]);
    });
    And(`the bot enabled auto-merge itself`, () => {
      w.autoMerge = ENABLED_BY_SELF;
    });
    When(`a later push re-routes the pull request to Woodhouse`, async () => {
      await routeOnce(w, { author: RENOVATE, action: "synchronize" });
    });
    Then(`Woodhouse is requested as the reviewer`, () => {
      expectRequested(w, ["woodhouse[bot]"]);
    });
    And(`the owner "my-user" is no longer requested as a reviewer`, () => {
      expectRemoved(w, ["my-user"]);
    });
  });

  Scenario(`Failing checks pull the owner in`, ({ Given, When, Then, And }) => {
    const w = world();

    givenRenovateBot({ Given, And }, w, () => {
      w.autoMerge = ENABLED_BY_SELF;
    });
    And(`auto-approval lists "my-user" as an owner`, () => {
      w.config = withOwner(requireConfig(w), "my-user");
    });
    When(`the bot's pull request fails its checks`, async () => {
      w.fixture.author = RENOVATE;
      // The opened routing is what puts Woodhouse in the review seat that the
      // failure event withdraws from; without it the routed map starts empty.
      await routeOnce(w, { author: RENOVATE, action: "opened" });
      await checkRunFails(w);
    });
    Then(`the owner "my-user" is requested as the reviewer`, () => {
      expectRequested(w, ["my-user"]);
    });
    And(`Woodhouse is no longer requested as a reviewer`, () => {
      expectRemoved(w, ["woodhouse[bot]"]);
    });
  });

  Scenario(`A recovered pull request is handed back to Woodhouse`, ({ Given, When, Then, And }) => {
    const w = world();

    Given(`the owner "my-user" was requested after the bot's checks failed`, async () => {
      w.config = parseConfig({ bots: [RENOVATE], owners: ["my-user"] });
      w.autoMerge = ENABLED_BY_SELF;
      w.fixture.author = RENOVATE;
      await routeOnce(w, { author: RENOVATE, action: "opened" });
      expectRequested(w, ["woodhouse[bot]"]);
      await checkRunFails(w);
      // No escalation exists yet, so this assertion is the one that fails red.
      expectRequested(w, ["my-user"]);
    });
    When(`the checks are fixed and pass`, async () => {
      await checkRunPasses(w);
    });
    Then(`Woodhouse submits an approval review`, () => {
      expectApproved(w);
    });
    And(`the owner "my-user" is no longer requested as a reviewer`, () => {
      expectRemoved(w, ["my-user"]);
    });
  });

  Scenario(
    `An owner pull request failing its checks gets no extra action`,
    ({ Given, When, Then }) => {
      const w = world();

      givenOwnerMyUser({ Given }, w);
      When(`"my-user" opens a pull request and its checks fail`, async () => {
        await routeOnce(w, { author: "my-user", action: "opened" });
        await checkRunFails(w);
      });
      Then(`no additional review request is made`, () => {
        // Pass-scoped: the open pass's own Woodhouse request is not "additional".
        expectNoWrites(w);
      });
    },
  );

  Scenario(`Repeated failure does not duplicate the owner request`, ({ Given, When, Then }) => {
    const w = world();

    Given(
      `the owner "my-user" is requested as the reviewer on the bot's pull request`,
      async () => {
        w.config ??= parseConfig({ bots: [RENOVATE], owners: ["my-user"] });
        await routeOnce(w, { author: RENOVATE, action: "opened" });
        expectRequested(w, ["my-user"]);
      },
    );
    When(`another check fails on the same commit`, async () => {
      await checkRunFails(w);
    });
    Then(`the owner "my-user" is requested as the reviewer exactly once`, () => {
      expectRequestedOnce(w, ["my-user"]);
    });
  });

  Scenario(
    `A bot touching a protected path is handed to the owners`,
    ({ Given, When, Then, And }) => {
      const w = world();

      givenRenovateBot({ Given, And }, w, () => {
        w.autoMerge = ENABLED_BY_SELF;
      });
      And(`auto-approval lists "my-user" as an owner`, () => {
        w.config = withOwner(requireConfig(w), "my-user");
      });
      And(`the pull request modifies ".github/woodhouse.yml"`, () => {
        w.fixture.filePages = [[{ filename: ".github/woodhouse.yml", status: "modified" }]];
      });
      When(`the checks pass`, async () => {
        w.fixture.author = RENOVATE;
        // In production the opened routing requested Woodhouse before the
        // checks-pass event arrived; this compresses that sequence.
        await routeOnce(w, { author: RENOVATE, action: "opened" });
        await checkRunPasses(w);
      });
      Then(`the owner "my-user" is requested as the reviewer`, () => {
        expectRequested(w, ["my-user"]);
      });
      And(`Woodhouse is no longer requested as a reviewer`, () => {
        expectRemoved(w, ["woodhouse[bot]"]);
      });
    },
  );
});
