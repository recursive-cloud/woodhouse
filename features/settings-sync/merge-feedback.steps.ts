/**
 * Step definitions for `features/settings-sync/merge-feedback.feature`.
 *
 * Every scenario drives the real `commentSettingsApplied` handler. The
 * resolver is either the literal fake (to pin invalidate/resolve ordering) or
 * the real `ConfigResolver` over a keyed `getContent` fake, exactly as the
 * handler unit suite does.
 */

import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { ConfigResolver, type ResolvedConfig } from "../../src/config/resolver.js";
import { KeyedMutex } from "../../src/lib/mutex.js";
import {
  SETTINGS_APPLIED_MARKER,
  commentSettingsApplied,
  type MergeFeedbackDeps,
} from "../../src/settings/mergeFeedback.js";
import { SIGN_OFF } from "../../src/approval/wording.js";
import type { ChangedFile } from "../../src/github/pulls.js";
import { type Comment, SETTINGS_FILE, fakeResolver, httpError, makeOctokit } from "./fakes.js";
import { fakeLogger } from "../support/scenario.js";

const feature = await loadFeature("features/settings-sync/merge-feedback.feature");

const ENABLED = { settings: { enabled: true }, repository: { has_issues: true } };

interface HarnessOptions {
  readonly configInput?: Record<string, unknown>;
  readonly resolution?: Partial<ResolvedConfig>;
  readonly files?: readonly ChangedFile[];
  readonly comments?: readonly Comment[];
  readonly configFiles?: Record<string, string>;
  readonly current?: Record<string, unknown>;
  readonly existingRulesets?: readonly { id: number; name: string }[];
  readonly dryRun?: boolean;
}

function requireValue<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The ${what} has not been built yet.`);
  }
  return value;
}

/** Data the fake octokit and fake resolver need from an options object. */
function octokitOptions(options: HarnessOptions) {
  return {
    files: options.files,
    comments: options.comments,
    configFiles: options.configFiles,
    current: options.current,
    existingRulesets: options.existingRulesets,
  };
}

const SCOPE = { owner: "acme", repo: "widgets", defaultBranch: "main" } as const;
const PR = { number: 7, merged: true, baseRef: "main" };

/** Handler harness with a literal fake resolver. */
function fakeHarness(options: HarnessOptions = {}) {
  const octokit = makeOctokit(octokitOptions(options));
  const log = fakeLogger();
  const fake = fakeResolver(options.configInput ?? ENABLED, options.resolution ?? {});
  const deps: MergeFeedbackDeps = {
    octokit: octokit.octokit as unknown as MergeFeedbackDeps["octokit"],
    resolver: fake.resolver,
    mutex: new KeyedMutex(),
    log,
    dryRun: options.dryRun ?? false,
  };

  return {
    ...octokit,
    log,
    resolver: fake,
    deps,
    scope: { ...SCOPE },
    pr: { ...PR },
  };
}

/** Handler harness with the real `ConfigResolver` over a keyed Contents fake. */
function realHarness(options: HarnessOptions = {}) {
  const octokit = makeOctokit(octokitOptions(options));
  const log = fakeLogger();
  const resolver = new ConfigResolver();
  const deps: MergeFeedbackDeps = {
    octokit: octokit.octokit as unknown as MergeFeedbackDeps["octokit"],
    resolver,
    mutex: new KeyedMutex(),
    log,
    dryRun: options.dryRun ?? false,
  };

  return {
    ...octokit,
    log,
    resolver,
    deps,
    scope: { ...SCOPE },
    pr: { ...PR },
  };
}

/** The created comment's body, as the handler posted it. */
function createdBody(createComment: ReturnType<typeof fakeHarness>["createComment"]): string {
  const call = createComment.mock.calls[0];
  if (call === undefined) throw new Error("No outcome comment was created.");
  return (call[0] as { body: string }).body;
}

describeFeature(feature, ({ Scenario }) => {
  Scenario(
    `A merged settings pull request gets an outcome comment`,
    ({ Given, When, Then, And }) => {
      let harness: ReturnType<typeof fakeHarness> | undefined;

      Given(
        `a pull request that changes ".github/woodhouse.yml" merged into the default branch`,
        () => {
          harness = fakeHarness({ configInput: { repository: { has_issues: true } } });
          expect(harness.listFiles).toBeDefined();
        },
      );
      When(`the merged delivery is handled`, async () => {
        const built = requireValue(harness, "feedback harness");
        await commentSettingsApplied(built.deps, built.scope, built.pr);
      });
      Then(`the repository is synced`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.calls).toEqual(["repos.get", "repos.update"]);
        expect(built.resolver.calls).toEqual(["invalidate", "resolve"]);
      });
      And(`the pull request receives one outcome comment listing what was applied`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.createComment).toHaveBeenCalledOnce();
        expect(built.updateComment).not.toHaveBeenCalled();

        const body = createdBody(built.createComment);
        expect(body.startsWith(SETTINGS_APPLIED_MARKER)).toBe(true);
        expect(body.trimEnd().endsWith(SIGN_OFF)).toBe(true);
        expect(body).toContain("Applied:\n- repository update: has_issues");
      });
    },
  );

  Scenario(`A merge into a non-default branch is silent`, ({ Given, When, Then, And }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a settings-changing pull request merged into a feature branch`, () => {
      harness = fakeHarness();
      harness.pr = { ...harness.pr, baseRef: "feature" };
      expect(harness.pr.baseRef).toBe("feature");
    });
    When(`the merged delivery is handled`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`no sync runs`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.listFiles).not.toHaveBeenCalled();
      expect(built.calls).toEqual([]);
    });
    And(`no comment is left`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.paginate).not.toHaveBeenCalledWith(built.listComments, expect.anything());
      expect(built.listComments).not.toHaveBeenCalled();
      expect(built.createComment).not.toHaveBeenCalled();
      expect(built.updateComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`A pull request closed without merging is silent`, ({ Given, When, Then, And }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a settings-changing pull request closed without merging`, () => {
      harness = fakeHarness();
      harness.pr = { ...harness.pr, merged: false };
      expect(harness.pr.merged).toBe(false);
    });
    When(`the merged delivery is handled`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`no sync runs`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.listFiles).not.toHaveBeenCalled();
      expect(built.calls).toEqual([]);
    });
    And(`no comment is left`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.paginate).not.toHaveBeenCalledWith(built.listComments, expect.anything());
      expect(built.listComments).not.toHaveBeenCalled();
      expect(built.createComment).not.toHaveBeenCalled();
      expect(built.updateComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`Deleting the settings file ends management`, ({ Given, When, Then, And }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a merged pull request that deletes ".github/woodhouse.yml"`, () => {
      harness = fakeHarness({
        files: [{ filename: ".github/woodhouse.yml", status: "removed" }],
        resolution: { localSource: undefined },
      });
      expect(harness.listFiles).toBeDefined();
    });
    When(`the merged delivery is handled`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`the deletion is treated as a settings change`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.resolver.calls).toEqual(["invalidate", "resolve"]);
    });
    And(`no sync runs because the local settings file is now absent`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.calls).toEqual([]);
      expect(built.log.debug).toHaveBeenCalledWith(
        { owner: "acme", repo: "widgets", reason: "no-local-file" },
        "Settings sync skipped",
      );
    });
    And(`no comment is left`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.paginate).not.toHaveBeenCalledWith(built.listComments, expect.anything());
      expect(built.listComments).not.toHaveBeenCalled();
      expect(built.createComment).not.toHaveBeenCalled();
      expect(built.updateComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`A re-delivery updates the outcome comment in place`, ({ Given, When, Then, And }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a merged settings pull request that already has an outcome comment`, () => {
      harness = fakeHarness({
        comments: [{ id: 42, body: `stale outcome\n${SETTINGS_APPLIED_MARKER}\n` }],
      });
      expect(harness.listComments).toBeDefined();
    });
    When(`the merged delivery is handled again`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`the existing comment is updated in place`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.updateComment).toHaveBeenCalledOnce();
      expect(built.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 42 }));
    });
    And(`no second comment is created`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.createComment).not.toHaveBeenCalled();
    });
  });

  Scenario(
    `A merged pull request that disables settings management is silent`,
    ({ Given, When, Then, And }) => {
      let harness: ReturnType<typeof fakeHarness> | undefined;

      Given(
        `a merged pull request whose resolved configuration disables settings management`,
        () => {
          harness = fakeHarness({
            configInput: { settings: { enabled: false }, repository: { has_issues: true } },
          });
        },
      );
      When(`the merged delivery is handled`, async () => {
        const built = requireValue(harness, "feedback harness");
        await commentSettingsApplied(built.deps, built.scope, built.pr);
      });
      Then(`the cache is still checked and the configuration still resolved`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.resolver.calls).toEqual(["invalidate", "resolve"]);
      });
      And(`no sync runs and no comment is left`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.calls).toEqual([]);
        expect(built.paginate).not.toHaveBeenCalledWith(built.listComments, expect.anything());
        expect(built.listComments).not.toHaveBeenCalled();
        expect(built.createComment).not.toHaveBeenCalled();
        expect(built.updateComment).not.toHaveBeenCalled();
        expect(built.log.debug).toHaveBeenCalledWith(
          { owner: "acme", repo: "widgets", reason: "settings-disabled" },
          "Settings sync skipped",
        );
      });
    },
  );

  Scenario(`A repository-level true overrides a baseline false`, ({ Given, When, Then, And }) => {
    let harness: ReturnType<typeof realHarness> | undefined;

    Given(
      `an owner baseline that disables settings management and a local settings file that enables it`,
      () => {
        harness = realHarness({
          files: [SETTINGS_FILE],
          configFiles: {
            ".github-private:woodhouse.yml": "settings:\n  enabled: false\n",
            "widgets:.github/woodhouse.yml":
              "settings:\n  enabled: true\nrepository:\n  has_issues: true\n",
          },
        });
      },
    );
    When(`the merged delivery is handled`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`the repository is synced`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.calls).toEqual(["repos.get", "repos.update"]);
    });
    And(`the pull request receives an outcome comment`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.createComment).toHaveBeenCalledOnce();
      expect(built.log.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: "settings-disabled" }),
        "Settings sync skipped",
      );
    });
  });

  Scenario(
    `A baseline merge without a local settings file is silent`,
    ({ Given, When, Then, And }) => {
      let harness: ReturnType<typeof realHarness> | undefined;
      let invalidateOwner: ReturnType<typeof vi.spyOn> | undefined;

      Given(
        `a merged settings change on the baseline repository that touches only the root baseline file`,
        () => {
          harness = realHarness({
            files: [{ filename: "woodhouse.yaml", status: "modified" }],
            configFiles: {
              ".github-private:woodhouse.yaml":
                "settings:\n  enabled: true\nrepository:\n  has_issues: true\n",
            },
          });
          harness.scope = { ...harness.scope, repo: ".github-private" };
          invalidateOwner = vi.spyOn(harness.resolver, "invalidateOwner");
          expect(harness.scope.repo).toBe(".github-private");
        },
      );
      When(`the merged delivery is handled`, async () => {
        const built = requireValue(harness, "feedback harness");
        await commentSettingsApplied(built.deps, built.scope, built.pr);
      });
      Then(`no sync runs because the file-presence gate reports no local file`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(requireValue(invalidateOwner, "invalidateOwner spy")).toHaveBeenCalledWith("acme");
        expect(built.calls).toEqual([]);
        expect(built.log.debug).toHaveBeenCalledWith(
          { owner: "acme", repo: ".github-private", reason: "no-local-file" },
          "Settings sync skipped",
        );
      });
      And(`no comment is left`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.createComment).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(
    `A baseline merge with a local settings file reports the baseline synced`,
    ({ Given, When, Then, And }) => {
      let harness: ReturnType<typeof realHarness> | undefined;

      Given(
        `a merged settings change on the baseline repository that carries its own settings file`,
        () => {
          harness = realHarness({
            files: [{ filename: "woodhouse.yaml", status: "modified" }],
            configFiles: {
              ".github-private:woodhouse.yml": "repository:\n  has_wiki: false\n",
              ".github-private:.github/woodhouse.yml":
                "settings:\n  enabled: true\nrepository:\n  has_issues: true\n",
            },
          });
          harness.scope = { ...harness.scope, repo: ".github-private" };
          expect(harness.scope.repo).toBe(".github-private");
        },
      );
      When(`the merged delivery is handled`, async () => {
        const built = requireValue(harness, "feedback harness");
        await commentSettingsApplied(built.deps, built.scope, built.pr);
      });
      Then(`the baseline repository is synced`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.calls).toEqual(["repos.get", "repos.update"]);
      });
      And(
        `the comment states the baseline was synced and other repositories adopt the change at their next event`,
        () => {
          const built = requireValue(harness, "feedback harness");
          const body = createdBody(built.createComment);
          expect(body).toContain(
            "This is the baseline repository, sir, so it has been synced directly.",
          );
          expect(body).toContain("Other repositories will adopt the change at their next event.");
        },
      );
      And(`the comment does not claim every repository was re-synced`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(createdBody(built.createComment)).not.toMatch(/every repository/i);
      });
    },
  );

  Scenario(`Failures are listed`, ({ Given, When, Then }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a settings sync where a write is forbidden`, () => {
      harness = fakeHarness({
        configInput: { settings: { enabled: true }, rulesets: [{ name: "main" }] },
        existingRulesets: [],
        current: { has_issues: false },
      });
      harness.request.mockRejectedValue(httpError(403, "Resource not accessible by integration"));
    });
    When(`the sync runs and the outcome comment is built`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`the comment lists the failure and its reason`, () => {
      const built = requireValue(harness, "feedback harness");
      const body = createdBody(built.createComment);
      expect(body).toContain("Failed:");
      expect(body).toMatch(/(?:^|\n)- rulesets: /);
      expect(body).toContain("Forbidden applying rulesets: Resource not accessible by integration");
    });
  });

  Scenario(`Nothing further to change`, ({ Given, When, Then }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a merged settings pull request whose settings were already fully applied`, () => {
      harness = fakeHarness({
        configInput: { repository: { has_issues: true } },
        current: { has_issues: true },
      });
    });
    When(`the merged delivery is handled`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(
      `the comment states the settings are in effect and nothing further needed changing`,
      () => {
        const built = requireValue(harness, "feedback harness");
        expect(built.calls).toEqual(["repos.get"]);
        expect(createdBody(built.createComment)).toContain(
          "The settings are in effect and nothing further needed changing.",
        );
      },
    );
  });

  Scenario(
    `The no-op wording is not used when branch protection was re-declared`,
    ({ Given, When, Then, And }) => {
      let harness: ReturnType<typeof fakeHarness> | undefined;

      Given(`a pure no-op configuration with a branchProtection block`, () => {
        harness = fakeHarness({
          configInput: {
            repository: { has_issues: true },
            branchProtection: { main: {} },
          },
          current: { has_issues: true },
        });
      });
      When(`the merged delivery is handled`, async () => {
        const built = requireValue(harness, "feedback harness");
        await commentSettingsApplied(built.deps, built.scope, built.pr);
      });
      Then(`the comment lists the re-declared branch-protection update rows`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(createdBody(built.createComment)).toContain("- branch-protection update: main");
      });
      And(`the comment does not state that nothing further needed changing`, () => {
        const built = requireValue(harness, "feedback harness");
        expect(createdBody(built.createComment)).not.toContain("nothing further needed changing");
      });
    },
  );

  Scenario(`A dry run logs the outcome and writes nothing`, ({ Given, When, Then, And }) => {
    let harness: ReturnType<typeof fakeHarness> | undefined;

    Given(`a merged settings pull request while dry-run mode is on`, () => {
      harness = fakeHarness({
        configInput: { repository: { has_issues: true } },
        current: { has_issues: false },
        dryRun: true,
      });
      expect(harness.deps.dryRun).toBe(true);
    });
    When(`the merged delivery is handled`, async () => {
      const built = requireValue(harness, "feedback harness");
      await commentSettingsApplied(built.deps, built.scope, built.pr);
    });
    Then(`the decision and comment body are logged`, () => {
      const built = requireValue(harness, "feedback harness");
      // Reads still happen; every write is suppressed by performWrite.
      expect(built.get).toHaveBeenCalled();
      expect(built.update).not.toHaveBeenCalled();

      const logged = built.log.info.mock.calls.map((call) => String(call[1])).join("\n");
      expect(logged).toContain(SETTINGS_APPLIED_MARKER);
      expect(logged).toContain(SIGN_OFF);
    });
    And(`GitHub receives no comment`, () => {
      const built = requireValue(harness, "feedback harness");
      expect(built.paginate).not.toHaveBeenCalledWith(built.listComments, expect.anything());
      expect(built.listComments).not.toHaveBeenCalled();
      expect(built.createComment).not.toHaveBeenCalled();
      expect(built.updateComment).not.toHaveBeenCalled();
      expect(built.deleteComment).not.toHaveBeenCalled();
    });
  });
});
