/**
 * Onboarding acceptance suite (REC-19).
 *
 * The scenarios are the spec of record: the onboarding walk is cheap-first and
 * stateless, so almost every assertion here is about which GitHub calls happened
 * and in what order — recorded by a fake octokit rather than mocked per line.
 *
 * The three fake worlds the suite spans — the onboarding walk (scenarios 1-12
 * and 15), the merge-feedback handler (scenario 13) and the white-glove check
 * handler (scenario 14) — live in `onboarding-world.ts`, so this file holds the
 * step definitions and the assertions over them.
 */

import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import yaml from "js-yaml";
import { SCHEMA_MODELINE } from "../../src/config/json-schema.js";
import { parseConfig } from "../../src/config/schema.js";
import { WHITE_GLOVE_CHECK_NAME } from "../../src/gatekeeper/constants.js";
import { reconcile } from "../../src/gatekeeper/handler.js";
import { handleOnboarding } from "../../src/onboarding/handler.js";
import {
  ONBOARDING_BRANCH,
  ONBOARDING_FILE_PATH,
  ONBOARDING_LABEL,
  ONBOARDING_PR_BODY,
  ONBOARDING_PR_TITLE,
  ONBOARDING_TEMPLATE,
} from "../../src/onboarding/wording.js";
import {
  SETTINGS_APPLIED_MARKER,
  commentSettingsApplied,
} from "../../src/settings/mergeFeedback.js";
import {
  HEAD_SHA,
  added,
  buildChecksWorld,
  buildMergeWorld,
  buildOnboarding,
  created,
  requireWorld,
  type ChecksWorld,
  type CommentParams,
  type MergeWorld,
  type OnboardingWorld,
} from "./onboarding-world.js";

const feature = await loadFeature("features/onboarding/onboarding.feature");

/** The installation account every scenario is about. */
const OWNER = "acme";

/* -------------------------------------------------------------------------
 * Scenarios
 * ---------------------------------------------------------------------- */

describeFeature(feature, ({ Scenario }) => {
  Scenario(`Fresh install`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(`the App is installed on a repository with no settings file`, async () => {
      world = buildOnboarding();
      await handleOnboarding(world.deps, OWNER, created("widgets"));

      // The walk starts with the local settings probe, cheap-first.
      expect(world.calls[0]).toBe("repos.getContent widgets:.github/woodhouse.yml");
    });
    Then(`Woodhouse opens an onboarding pull request adding the starter configuration`, () => {
      const { calls, createRef, createOrUpdateFileContents, create, addLabels } =
        requireWorld(world);

      // Probes, then the offer search, then the write facts, then the writes.
      expect(calls).toEqual([
        "repos.getContent widgets:.github/woodhouse.yml",
        "repos.getContent widgets:.github/woodhouse.yaml",
        "pulls.list widgets",
        "repos.get widgets",
        `git.getRef widgets:heads/main`,
        `git.getRef widgets:heads/${ONBOARDING_BRANCH}`,
        "git.createRef",
        "repos.createOrUpdateFileContents",
        "pulls.create widgets",
        "issues.addLabels widgets",
      ]);

      // The four wording constants the write args are built from.
      expect(ONBOARDING_BRANCH).toBe("woodhouse/onboarding");
      expect(ONBOARDING_PR_TITLE).toBe("chore: onboard to Woodhouse");
      expect(ONBOARDING_LABEL).toBe("woodhouse: onboarding");
      expect(ONBOARDING_FILE_PATH).toBe(".github/woodhouse.yml");

      expect(createRef).toHaveBeenCalledWith({
        owner: OWNER,
        repo: "widgets",
        ref: `refs/heads/${ONBOARDING_BRANCH}`,
        sha: "base-sha",
      });

      const contentsArg = createOrUpdateFileContents.mock.calls[0]![0] as {
        path: string;
        content: string;
      };
      expect(contentsArg.path).toBe(ONBOARDING_FILE_PATH);

      const template = Buffer.from(contentsArg.content, "base64").toString("utf8");
      expect(template).toBe(ONBOARDING_TEMPLATE);
      expect(template.startsWith(SCHEMA_MODELINE)).toBe(true);
      // File presence is the opt-in: no settings section in the starter file.
      expect(yaml.load(template)).toBeNull();
      expect(parseConfig(yaml.load(template)).ok).toBe(true);
      expect(template).toContain("woodhouse.example.yml");

      expect(create).toHaveBeenCalledWith({
        owner: OWNER,
        repo: "widgets",
        title: ONBOARDING_PR_TITLE,
        head: ONBOARDING_BRANCH,
        base: "main",
        body: ONBOARDING_PR_BODY,
      });
      expect(addLabels).toHaveBeenCalledWith({
        owner: OWNER,
        repo: "widgets",
        issue_number: 42,
        labels: [ONBOARDING_LABEL],
      });
    });
  });

  Scenario(`Repository added to an existing installation`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(`a repository is added to an installation that already existed`, async () => {
      world = buildOnboarding();
      await handleOnboarding(world.deps, OWNER, added("gadgets"));

      expect(world.calls[0]).toBe("repos.getContent gadgets:.github/woodhouse.yml");
    });
    Then(`the same onboarding offer is made for that repository`, () => {
      const { calls, createRef, createOrUpdateFileContents, create, addLabels } =
        requireWorld(world);

      // The addition is walked exactly like a fresh install's repository.
      expect(calls).toContain("git.createRef");
      expect(calls).toContain("repos.createOrUpdateFileContents");
      expect(createRef).toHaveBeenCalledWith(expect.objectContaining({ repo: "gadgets" }));
      expect(createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "gadgets" }),
      );
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "gadgets" }));
      expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ repo: "gadgets" }));
    });
  });

  Scenario(`Fresh install on all repositories`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(
      `the App is newly installed with repository selection All and the delivery carries no repository list`,
      async () => {
        world = buildOnboarding({
          accessibleRepos: [{ name: "alpha" }, { name: "" }, null, { name: "beta" }],
        });
        const payload = { action: "created" };
        expect(payload).not.toHaveProperty("installation");

        await handleOnboarding(world.deps, OWNER, payload);
        expect(world.paginate).toHaveBeenCalledOnce();
      },
    );
    Then(
      `Woodhouse enumerates the repositories accessible to the installation and makes the same onboarding offer to each of them`,
      () => {
        const { paginate, listReposAccessibleToInstallation, create, addLabels } =
          requireWorld(world);

        expect(paginate).toHaveBeenCalledWith(listReposAccessibleToInstallation, {
          per_page: 100,
        });
        expect(create.mock.calls.map((call) => (call[0] as { repo: string }).repo)).toEqual([
          "alpha",
          "beta",
        ]);
        // The empty-name and null entries in the enumeration are dropped by the
        // same filter the payload path uses.
        expect(addLabels).toHaveBeenCalledTimes(2);
      },
    );
  });

  Scenario(`An existing installation is switched to all repositories`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(
      `an existing installation's repository selection is switched to All and the delivery enumerates the newly-accessible repositories`,
      async () => {
        world = buildOnboarding({
          accessibleRepos: [{ name: "managed" }, { name: "free" }],
          presentPaths: ["managed:.github/woodhouse.yml"],
        });
        // The access switch arrives as an `added` delta with no names.
        await handleOnboarding(world.deps, OWNER, { action: "added", repositories_added: [] });

        expect(world.calls[0]).toBe("apps.listReposAccessibleToInstallation page=1 per_page=100");
      },
    );
    Then(
      `the newly-accessible repositories are treated like any other batch — repositories without a config file receive the offer and those with one are skipped`,
      () => {
        const { calls, create, addLabels } = requireWorld(world);

        // A settings file short-circuits before the offer search.
        expect(calls).not.toContain("pulls.list managed");
        expect(calls).toContain("pulls.list free");

        expect(create).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "free" }));
        expect(calls).not.toContain("pulls.create managed");
        expect(calls).not.toContain("issues.addLabels managed");

        expect(addLabels).toHaveBeenCalledOnce();
        expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ repo: "free" }));
      },
    );
  });

  Scenario(`Enumeration fails`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(`enumerating the repositories accessible to the installation fails`, async () => {
      world = buildOnboarding({ enumerationFails: true });
      await handleOnboarding(world.deps, OWNER, { action: "created" });

      expect(world.calls).toEqual(["apps.listReposAccessibleToInstallation page=1 per_page=100"]);
    });
    Then(
      `no onboarding pull requests are opened for that delivery and the failure is logged`,
      () => {
        const { calls, createRef, createOrUpdateFileContents, create, addLabels, log } =
          requireWorld(world);

        expect(calls).toEqual(["apps.listReposAccessibleToInstallation page=1 per_page=100"]);
        expect(createRef).not.toHaveBeenCalled();
        expect(createOrUpdateFileContents).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(addLabels).not.toHaveBeenCalled();

        expect(log.error).toHaveBeenCalledOnce();
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ owner: OWNER, action: "created" }),
          expect.stringContaining("Could not enumerate"),
        );
      },
    );
  });

  Scenario(`Local config already present`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(
      `the App is installed on a repository that already has ".github/woodhouse.yaml"`,
      async () => {
        world = buildOnboarding({ presentPaths: ["widgets:.github/woodhouse.yaml"] });
        await handleOnboarding(world.deps, OWNER, created("widgets"));

        // Both probes happened; the second found the file.
        expect(world.calls).toEqual([
          "repos.getContent widgets:.github/woodhouse.yml",
          "repos.getContent widgets:.github/woodhouse.yaml",
        ]);
      },
    );
    Then(`no onboarding pull request is opened`, () => {
      const { calls, createRef, createOrUpdateFileContents, create, addLabels } =
        requireWorld(world);

      expect(createRef).not.toHaveBeenCalled();
      expect(createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();

      // The file short-circuits before the pull-request search.
      expect(calls).not.toContain("pulls.list widgets");
    });
  });

  Scenario(`The baseline repository is offered like any other`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(
      `the App is installed on the baseline repository, which carries a root "woodhouse.yml" but no ".github/woodhouse.yml"`,
      async () => {
        // The root file exists but must never be requested: it is not a local
        // settings file, so the walk has no reason to look at it.
        world = buildOnboarding({ presentPaths: ["woodhouse.yml"] });
        await handleOnboarding(world.deps, OWNER, created(".github-private"));

        expect(world.calls[0]).toBe("repos.getContent .github-private:.github/woodhouse.yml");
      },
    );
    Then(
      `the onboarding offer is made for it — the root baseline file is not a local settings file`,
      () => {
        const { calls, getContent, list, create, addLabels } = requireWorld(world);

        expect(getContent.mock.calls.map(([params]) => params.path)).toEqual([
          ".github/woodhouse.yml",
          ".github/woodhouse.yaml",
        ]);
        expect(calls).not.toContain("repos.getContent .github-private:woodhouse.yml");

        expect(list).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: ".github-private" }));
        expect(addLabels).toHaveBeenCalledOnce();
      },
    );
  });

  Scenario(`A repository under an enabled baseline still receives the offer`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;
    let baselineEnabled = false;

    When(
      `a repository has no settings file and the owner baseline resolves settings management on`,
      async () => {
        // Plain data standing in for the owner baseline: the walk never
        // consults a resolved configuration, so this can only be inert.
        const baseline = parseConfig({ settings: { enabled: true } });
        if (!baseline.ok) throw new Error("The baseline fixture must parse.");
        baselineEnabled = baseline.config.settings.enabled;
        expect(baselineEnabled).toBe(true);

        world = buildOnboarding();
        await handleOnboarding(world.deps, OWNER, created("widgets"));

        expect(world.calls[0]).toBe("repos.getContent widgets:.github/woodhouse.yml");
      },
    );
    Then(
      `the onboarding offer is still made for it — the local file is the per-repository opt-in`,
      () => {
        const { calls, getContent, list, create, addLabels } = requireWorld(world);

        // The baseline repository was never read: the local file is the
        // only opt-in the walk recognises.
        expect(calls.some((call) => call.includes(".github-private"))).toBe(false);
        expect(getContent).toHaveBeenCalledTimes(2);
        expect(list).toHaveBeenCalledOnce();

        expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "widgets" }));
        expect(addLabels).toHaveBeenCalledOnce();
        expect(baselineEnabled).toBe(true);
      },
    );
  });

  Scenario(`The open-pull-request probe fails`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(
      `a repository has no settings file and the probe for an open onboarding pull request fails`,
      async () => {
        world = buildOnboarding({ probeFailsFor: ["widgets"] });
        await handleOnboarding(world.deps, OWNER, created("widgets", "healthy"));

        expect(world.calls).toContain("pulls.list widgets");
      },
    );
    Then(
      `no onboarding pull request is opened for it, the failure is logged, and the walk continues with the remaining repositories`,
      () => {
        const { calls, create, addLabels, log } = requireWorld(world);

        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ owner: OWNER, repo: "widgets" }),
          expect.stringContaining("Onboarding failed"),
        );
        expect(calls).not.toContain("pulls.create widgets");
        expect(create).not.toHaveBeenCalledWith(expect.objectContaining({ repo: "widgets" }));

        // The walk continued to the next repository in the batch.
        expect(create).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "healthy" }));
        expect(addLabels).toHaveBeenCalledOnce();
        expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ repo: "healthy" }));
      },
    );
  });

  Scenario(`Re-delivery`, ({ Given, When, Then }) => {
    let world: OnboardingWorld | undefined;

    Given(`an onboarding pull request is open for a repository`, async () => {
      world = buildOnboarding({ openOnboardingPr: true });
      await handleOnboarding(world.deps, OWNER, created("widgets"));

      // The open offer is found by the probe and suppresses every write.
      expect(world.list).toHaveBeenCalledOnce();
      expect(world.create).not.toHaveBeenCalled();
    });
    When(
      `the installation event re-delivers while the onboarding pull request is open`,
      async () => {
        const current = requireWorld(world);
        await handleOnboarding(current.deps, OWNER, created("widgets"));
        await handleOnboarding(current.deps, OWNER, created("widgets"));

        // Each re-delivery re-probed the open offer.
        expect(current.list).toHaveBeenCalledTimes(3);
      },
    );
    Then(`no second branch, commit, or pull request is created`, () => {
      const { createRef, createOrUpdateFileContents, create, addLabels } = requireWorld(world);

      expect(createRef).not.toHaveBeenCalled();
      expect(createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });
  });

  Scenario(`Closed without merging`, ({ Given, When, Then }) => {
    let world: OnboardingWorld | undefined;
    let callsBefore = -1;
    let deliveries = 0;

    Given(`the onboarding pull request was closed without merging`, async () => {
      // The branch still exists from an earlier offer, and no pull request is
      // open any more: GitHub's state after a close without merge.
      world = buildOnboarding({ branchExistsRepos: ["widgets"] });
      await handleOnboarding(world.deps, OWNER, created("widgets"));
      deliveries += 1;

      expect(world.create).toHaveBeenCalledOnce();
      expect(world.createRef).not.toHaveBeenCalled();
      expect(world.createOrUpdateFileContents).not.toHaveBeenCalled();

      callsBefore = world.calls.length;
    });
    When(`no installation event follows`, () => {
      // Nothing is delivered, so the world stays exactly as the Given left it.
      expect(deliveries).toBe(1);
      expect(requireWorld(world).calls.length).toBe(callsBefore);
    });
    Then(`the repository remains un-onboarded and untouched`, () => {
      const { calls, create } = requireWorld(world);

      expect(calls.length).toBe(callsBefore);
      expect(calls.slice(callsBefore)).toEqual([]);
      expect(calls.slice(callsBefore)).not.toContain("pulls.create widgets");
      expect(create).toHaveBeenCalledOnce();
    });
  });

  Scenario(`Repeated enumeration`, ({ Given, When, Then }) => {
    let world: OnboardingWorld | undefined;

    Given(`an acted-on installation event that carries no repository list`, async () => {
      world = buildOnboarding({
        accessibleRepos: [{ name: "alpha" }, { name: "beta" }],
        openOnboardingPr: true,
      });
      await handleOnboarding(world.deps, OWNER, { action: "created" });

      expect(world.paginate).toHaveBeenCalledOnce();
      expect(world.create).not.toHaveBeenCalled();
    });
    When(`it re-delivers, so the accessible-repository enumeration runs again`, async () => {
      const current = requireWorld(world);
      await handleOnboarding(current.deps, OWNER, { action: "created" });

      expect(current.paginate).toHaveBeenCalledTimes(2);
    });
    Then(
      `no second branch, commit, or pull request is created for any repository in the enumerated batch`,
      () => {
        const { paginate, createRef, createOrUpdateFileContents, create, addLabels } =
          requireWorld(world);

        expect(paginate).toHaveBeenCalledTimes(2);
        expect(createRef).not.toHaveBeenCalled();
        expect(createOrUpdateFileContents).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(addLabels).not.toHaveBeenCalled();
      },
    );
  });

  Scenario(`The onboarding pull request merges`, ({ When, Then }) => {
    let world: MergeWorld | undefined;

    When(`the onboarding pull request merges into the default branch`, async () => {
      world = buildMergeWorld();

      await commentSettingsApplied(
        world.deps,
        { owner: OWNER, repo: "widgets", defaultBranch: "main" },
        { number: 7, merged: true, baseRef: "main" },
      );

      // The merged file list was read before anything was resolved or synced.
      expect(world.paginate).toHaveBeenCalledWith(
        world.listFiles,
        expect.objectContaining({ pull_number: 7 }),
      );
    });
    Then(
      `the settings sync runs for the repository and the outcome comment is left on the pull request`,
      () => {
        const { calls, createComment, updateComment } = requireWorld(world);

        // The sync ran end to end: repository read then write, then the
        // rulesets read the applier reaches past the repository applier.
        expect(calls).toContain("repos.get");
        expect(calls).toContain("repos.update");
        expect(calls).toContain("rulesets.list");

        const commentCalls = [...createComment.mock.calls, ...updateComment.mock.calls];
        expect(commentCalls).toHaveLength(1);

        const params = commentCalls[0]![0] as unknown as CommentParams;
        expect(params.issue_number).toBe(7);
        expect(params.body).toContain(SETTINGS_APPLIED_MARKER);
      },
    );
  });

  Scenario(`Pull request on an un-onboarded repository`, ({ When, Then }) => {
    let world: ChecksWorld | undefined;

    When(`any pull request opens in a repository with no settings file`, async () => {
      world = buildChecksWorld();

      await reconcile(world.deps, OWNER, "widgets", HEAD_SHA);

      expect(world.listForRef).toHaveBeenCalledOnce();
    });
    Then(`the white-glove check is posted and no settings are written`, () => {
      const {
        applierCalls,
        create,
        update,
        reposGet,
        reposUpdate,
        replaceAllTopics,
        updateBranchProtection,
        createLabel,
        request,
      } = requireWorld(world);

      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: OWNER,
          repo: "widgets",
          name: WHITE_GLOVE_CHECK_NAME,
          head_sha: HEAD_SHA,
        }),
      );
      expect(update).not.toHaveBeenCalled();

      // No local settings file: every applier surface stayed untouched.
      expect(applierCalls).toEqual([]);
      expect(reposGet).not.toHaveBeenCalled();
      expect(reposUpdate).not.toHaveBeenCalled();
      expect(replaceAllTopics).not.toHaveBeenCalled();
      expect(updateBranchProtection).not.toHaveBeenCalled();
      expect(createLabel).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });
  });

  Scenario(`Dry-run installation`, ({ When, Then }) => {
    let world: OnboardingWorld | undefined;

    When(`the App is installed on a repository while dry-run mode is on`, async () => {
      world = buildOnboarding({}, true);
      await handleOnboarding(world.deps, OWNER, created("widgets"));

      expect(world.deps.dryRun).toBe(true);
      expect(world.calls[0]).toBe("repos.getContent widgets:.github/woodhouse.yml");
    });
    Then(
      `the would-be onboarding pull request is logged and no branch, commit, or pull request is created`,
      () => {
        const {
          calls,
          getContent,
          list,
          get,
          getRef,
          createRef,
          createOrUpdateFileContents,
          create,
          addLabels,
          log,
        } = requireWorld(world);

        // The decision was evaluated in full: every read happened.
        expect(getContent).toHaveBeenCalledTimes(2);
        expect(list).toHaveBeenCalledOnce();
        expect(get).toHaveBeenCalledOnce();
        expect(getRef).toHaveBeenCalledTimes(2);
        expect(calls).toContain("pulls.list widgets");

        // Not one write, and the whole would-be pull request is logged.
        expect(createRef).not.toHaveBeenCalled();
        expect(createOrUpdateFileContents).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(addLabels).not.toHaveBeenCalled();

        expect(log.info).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: ONBOARDING_BRANCH,
            file: ONBOARDING_FILE_PATH,
            title: ONBOARDING_PR_TITLE,
            body: ONBOARDING_PR_BODY,
          }),
          expect.stringContaining("DRY_RUN: would open onboarding pull request"),
        );
      },
    );
  });
});
