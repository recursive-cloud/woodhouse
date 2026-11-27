import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { resetAppLoginCache } from "../../src/approval/silverPlatter.js";
import {
  DEPENDABOT,
  ENABLED_BY_SELF,
  RENOVATE,
  expectNoWrites,
  expectRemoved,
  expectRequested,
  parseConfig,
  requireConfig,
  routeOnce,
  withOwner,
  world,
} from "./routing-world.js";

const feature = await loadFeature("features/review-routing/routing.feature");

describeFeature(feature, ({ BeforeEachScenario, Scenario }) => {
  // appLogin is cached per process; every scenario owns a fresh fake octokit.
  BeforeEachScenario(() => resetAppLoginCache());

  Scenario(`Owner pull request routes Woodhouse as reviewer`, ({ Given, When, Then }) => {
    const w = world();

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
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

      Given(`auto-approval lists the Renovate bot as a bot`, () => {
        w.config = parseConfig({ bots: [RENOVATE] });
      });
      And(`the bot enabled auto-merge itself`, () => {
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

      Given(`auto-approval lists the Renovate bot as a bot`, () => {
        w.config = parseConfig({ bots: [RENOVATE] });
      });
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

      Given(`auto-approval lists the Renovate bot as a bot`, () => {
        w.config = parseConfig({ bots: [RENOVATE] });
      });
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

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
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

    Given(`auto-approval lists "my-user" as an owner`, () => {
      w.config = parseConfig({ owners: ["my-user"] });
    });
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

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
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

    Given(`auto-approval lists the Renovate bot as a bot`, () => {
      w.config = parseConfig({ bots: [RENOVATE] });
    });
    And(`auto-approval lists "my-user" as an owner`, () => {
      w.config = withOwner(requireConfig(w), "my-user");
    });
    And(`the owner "my-user" is requested as the reviewer on the bot's pull request`, async () => {
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
});
