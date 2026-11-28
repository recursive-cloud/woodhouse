import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { titlePatternDescription } from "../../src/conventional/parse.js";
import { DRESS_CODE_CHECK_NAME } from "../../src/dresscode/constants.js";
import {
  HEAD_SHA,
  NEW_SHA,
  makeDressCodeWorld,
  requireWorld,
  type DressCodeWorld,
} from "./title-world.js";
import { readCell } from "../support/scenario.js";

const feature = await loadFeature("features/dress-code/title.feature");

/** Examples cells quote titles; the parser sees the title without the quotes. */
function unquoteTitle(cell: string): string {
  const text = cell.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  throw new Error(`Expected a quoted title cell, got ${JSON.stringify(cell)}`);
}

function requireRunSummary(world: DressCodeWorld, sha: string): string {
  const summary = world.latestRun(sha).output?.summary;
  if (summary === undefined) {
    throw new Error(`The dress-code run on ${sha} has no output summary.`);
  }
  return summary;
}

function expectCompleted(world: DressCodeWorld, sha: string, conclusion: string): void {
  const run = world.latestRun(sha);
  expect(run.name).toBe(DRESS_CODE_CHECK_NAME);
  expect(run.status).toBe("completed");
  expect(run.conclusion).toBe(conclusion);
}

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  Scenario(`A conventional title passes`, ({ Given, And, When, Then }) => {
    let world: DressCodeWorld | undefined;

    Given(`dress-code is enabled`, () => {
      world = makeDressCodeWorld({ enabled: true });
    });
    And(`a pull request titled "feat(settings): add the environments section"`, () => {
      requireWorld(world).setTitle("feat(settings): add the environments section");
    });
    When(`the dress-code check runs for its head commit`, async () => {
      const built = requireWorld(world);
      await built.runCheck(built.pullRequests[0]?.title ?? "");
    });
    Then(`the "woodhouse/dress-code" check reports success`, () => {
      expectCompleted(requireWorld(world), HEAD_SHA, "success");
    });
  });

  ScenarioOutline(
    `A non-conventional title fails with guidance`,
    ({ Given, And, When, Then }, variables) => {
      let world: DressCodeWorld | undefined;
      let title = "";

      Given(`dress-code is enabled`, () => {
        world = makeDressCodeWorld({ enabled: true });
      });
      And(`a pull request titled <title>`, () => {
        title = unquoteTitle(readCell(variables, "title"));
        requireWorld(world).setTitle(title);
      });
      When(`the dress-code check runs for its head commit`, async () => {
        await requireWorld(world).runCheck(title);
      });
      Then(`the "woodhouse/dress-code" check reports failure`, () => {
        expectCompleted(requireWorld(world), HEAD_SHA, "failure");
      });
      And(`the check output names the expected pattern and the offending title`, () => {
        const summary = requireRunSummary(requireWorld(world), HEAD_SHA);
        expect(summary).toContain(titlePatternDescription());
        expect(summary).toContain(JSON.stringify(title));
      });
    },
  );

  Scenario(`An edited title flips a passing check to failure`, ({ Given, And, When, Then }) => {
    let world: DressCodeWorld | undefined;

    Given(`dress-code is enabled`, () => {
      world = makeDressCodeWorld({ enabled: true });
    });
    And(
      `a pull request titled "feat: add an environments section" whose check reported success`,
      async () => {
        const built = requireWorld(world);
        built.setTitle("feat: add an environments section");
        await built.runCheck("feat: add an environments section");
        expectCompleted(built, HEAD_SHA, "success");
      },
    );
    When(`the title is edited to "quick fix"`, async () => {
      const built = requireWorld(world);
      built.setTitle("quick fix");
      await built.runCheck("quick fix");
    });
    Then(`the "woodhouse/dress-code" check reports failure for the same head commit`, () => {
      const built = requireWorld(world);
      // Updated in place: the first run's create is the only create.
      expect(built.create).toHaveBeenCalledOnce();
      expect(built.update).toHaveBeenCalledOnce();
      expect(built.runsFor(HEAD_SHA)).toHaveLength(1);
      expectCompleted(built, HEAD_SHA, "failure");
    });
  });

  Scenario(
    `An edited title flips a failing check back to success`,
    ({ Given, And, When, Then }) => {
      let world: DressCodeWorld | undefined;

      Given(`dress-code is enabled`, () => {
        world = makeDressCodeWorld({ enabled: true });
      });
      And(`a pull request titled "quick fix" whose check reported failure`, async () => {
        const built = requireWorld(world);
        built.setTitle("quick fix");
        await built.runCheck("quick fix");
        expectCompleted(built, HEAD_SHA, "failure");
      });
      When(`the title is edited to "fix: handle the empty payload"`, async () => {
        const built = requireWorld(world);
        built.setTitle("fix: handle the empty payload");
        await built.runCheck("fix: handle the empty payload");
      });
      Then(`the "woodhouse/dress-code" check reports success for the same head commit`, () => {
        const built = requireWorld(world);
        expect(built.create).toHaveBeenCalledOnce();
        expect(built.update).toHaveBeenCalledOnce();
        expect(built.runsFor(HEAD_SHA)).toHaveLength(1);
        expectCompleted(built, HEAD_SHA, "success");
      });
    },
  );

  Scenario(`A push re-checks the new head commit`, ({ Given, And, When, Then }) => {
    let world: DressCodeWorld | undefined;

    Given(`dress-code is enabled`, () => {
      world = makeDressCodeWorld({ enabled: true });
    });
    And(`a pull request titled "feat: add an environments section"`, () => {
      requireWorld(world).setTitle("feat: add an environments section");
    });
    When(`a new commit pushes to its head branch`, async () => {
      await requireWorld(world).runCheck("feat: add an environments section", NEW_SHA);
    });
    Then(`the "woodhouse/dress-code" check reports success for the new head commit`, () => {
      expectCompleted(requireWorld(world), NEW_SHA, "success");
    });
    And(`no duplicate check run exists on that head commit`, () => {
      const built = requireWorld(world);
      expect(built.runsFor(NEW_SHA)).toHaveLength(1);
      const createsForNewHead = built.create.mock.calls.filter(
        ([params]) => (params as { head_sha?: unknown }).head_sha === NEW_SHA,
      );
      expect(createsForNewHead).toHaveLength(1);
    });
  });

  Scenario(
    `A re-requested check completes instead of staying queued`,
    ({ Given, And, When, Then }) => {
      let world: DressCodeWorld | undefined;

      Given(`dress-code is enabled`, () => {
        world = makeDressCodeWorld({ enabled: true });
      });
      And(`a pull request titled "feat: add an environments section"`, () => {
        requireWorld(world).setTitle("feat: add an environments section");
      });
      When(`the "woodhouse/dress-code" check is re-requested from the Checks tab`, async () => {
        const built = requireWorld(world);
        // GitHub re-queues the existing run before delivering the webhook.
        built.queueRun();
        await built.reRequest();
      });
      Then(`the check reports success for the head commit`, () => {
        expectCompleted(requireWorld(world), HEAD_SHA, "success");
      });
    },
  );

  Scenario(`A disabled check posts nothing`, ({ Given, And, When, Then }) => {
    let world: DressCodeWorld | undefined;

    Given(`dress-code is disabled`, () => {
      world = makeDressCodeWorld({ enabled: false });
    });
    And(`a pull request titled "quick fix"`, () => {
      requireWorld(world).setTitle("quick fix");
    });
    When(`the pull request opens`, async () => {
      await requireWorld(world).runCheck("quick fix");
    });
    Then(`no "woodhouse/dress-code" check run exists on its head commit`, () => {
      const built = requireWorld(world);
      expect(built.runsFor(HEAD_SHA)).toHaveLength(0);
      expect(built.create).not.toHaveBeenCalled();
      expect(built.update).not.toHaveBeenCalled();
    });
  });
});
