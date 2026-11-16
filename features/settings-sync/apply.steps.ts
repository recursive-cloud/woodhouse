/**
 * Step definitions for `features/settings-sync/apply.feature`.
 *
 * The app-level scenarios drive the real `createApp` wiring through the fake
 * Probot, so the push gate, the real `ConfigResolver` and the shared mutex are
 * all exercised. The sync-level scenarios call `syncSettings` directly with the
 * same fake octokit the unit suite uses.
 */

import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { Logger } from "pino";
import { createApp } from "../../src/app.js";
import { Allowlist } from "../../src/security/allowlist.js";
import { type ApplyContext, syncSettings } from "../../src/settings/apply.js";
import type { ResolvedConfig } from "../../src/config/resolver.js";
import {
  type Gate,
  OPEN_GATE,
  closedContext,
  fakeLogger,
  fakeProbot,
  makeAppOctokit,
  makeApplyOctokit,
  manualGate,
  pushContext,
  resolvedConfig,
  settle,
} from "./fakes.js";

const feature = await loadFeature("features/settings-sync/apply.feature");

const ENABLED_CONFIG = "settings:\n  enabled: true\nrepository:\n  has_issues: true\n";

const CONFIG_FILES = { "widgets:.github/woodhouse.yml": ENABLED_CONFIG };

type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

function requireValue<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The ${what} has not been built yet.`);
  }
  return value;
}

/** Build the app-level harness with a real resolver and the shared fake Probot. */
function appHarness() {
  const { app, deliver } = fakeProbot();
  createApp({
    allowlist: new Allowlist(["trusted-org"]),
    baselineRepo: ".github-private",
    dryRun: false,
  })(app);
  return { deliver, calls: [] as string[] };
}

/** The apply context every syncSettings-level scenario uses. */
function applyContext(
  octokit: ReturnType<typeof makeApplyOctokit>["octokit"],
  log: Logger,
): ApplyContext {
  return {
    octokit,
    owner: "acme",
    repo: "widgets",
    log,
    dryRun: false,
  } as unknown as ApplyContext;
}

describeFeature(feature, ({ ScenarioOutline, Scenario }) => {
  Scenario(
    `A settings change landing on the default branch is synced`,
    ({ Given, When, Then, And }) => {
      let calls: string[] = [];
      let octokit: ReturnType<typeof makeAppOctokit> | undefined;
      let handled: Promise<void> | undefined;

      Given(`a default-branch push that modifies ".github/woodhouse.yml"`, () => {
        const harness = appHarness();
        calls = harness.calls;
        octokit = makeAppOctokit({
          label: "push",
          calls,
          gate: OPEN_GATE,
          current: { has_issues: false },
          configFiles: CONFIG_FILES,
        });
        handled = harness.deliver(
          "push",
          pushContext(octokit.octokit, {
            ref: "refs/heads/main",
            changed: [".github/woodhouse.yml"],
          }),
        );
        expect(handled).toBeInstanceOf(Promise);
      });
      When(`the push delivery is handled`, async () => {
        await requireValue(handled, "push delivery");
      });
      Then(`the repository is synced to its cascaded configuration`, () => {
        expect(calls).toEqual(["push:repos.get", "push:repos.update"]);
      });
      And(`no outcome comment is left`, () => {
        const surface = requireValue(octokit, "fake octokit");
        expect(surface.paginate).not.toHaveBeenCalledWith(
          surface.listComments,
          expect.anything(),
        );
        expect(surface.listComments).not.toHaveBeenCalled();
        expect(surface.createComment).not.toHaveBeenCalled();
        expect(surface.updateComment).not.toHaveBeenCalled();
      });
    },
  );

  Scenario(`A push to another branch does not trigger a sync`, ({ Given, When, Then }) => {
    let calls: string[] = [];
    let handled: Promise<void> | undefined;

    Given(`a push to another branch that modifies ".github/woodhouse.yml"`, () => {
      const harness = appHarness();
      calls = harness.calls;
      const octokit = makeAppOctokit({
        label: "push",
        calls,
        gate: OPEN_GATE,
        configFiles: CONFIG_FILES,
      });
      handled = harness.deliver(
        "push",
        pushContext(octokit.octokit, {
          ref: "refs/heads/feature/x",
          changed: [".github/woodhouse.yml"],
        }),
      );
      expect(handled).toBeInstanceOf(Promise);
    });
    When(`the push delivery is handled`, async () => {
      await requireValue(handled, "push delivery");
    });
    Then(`no settings sync runs for the repository`, () => {
      expect(calls).toEqual([]);
    });
  });

  Scenario(`A branch deletion does not trigger a sync`, ({ Given, When, Then }) => {
    let calls: string[] = [];
    let handled: Promise<void> | undefined;

    Given(`a default-branch push that deletes ".github/woodhouse.yml"`, () => {
      const harness = appHarness();
      calls = harness.calls;
      const octokit = makeAppOctokit({
        label: "push",
        calls,
        gate: OPEN_GATE,
        configFiles: CONFIG_FILES,
      });
      handled = harness.deliver(
        "push",
        pushContext(octokit.octokit, {
          ref: "refs/heads/main",
          changed: [".github/woodhouse.yml"],
          deleted: true,
        }),
      );
      expect(handled).toBeInstanceOf(Promise);
    });
    When(`the push delivery is handled`, async () => {
      await requireValue(handled, "push delivery");
    });
    Then(`no settings sync runs for the repository`, () => {
      expect(calls).toEqual([]);
    });
  });

  Scenario(
    `A push touching a file merely named like the settings file is only a re-check`,
    ({ Given, When, Then, And }) => {
      let calls: string[] = [];
      let octokit: ReturnType<typeof makeAppOctokit> | undefined;
      let handled: Promise<void> | undefined;

      Given(`a default-branch push that touches only "docs/woodhouse.yml"`, () => {
        const harness = appHarness();
        calls = harness.calls;
        octokit = makeAppOctokit({
          label: "push",
          calls,
          gate: OPEN_GATE,
          current: { has_issues: true },
          configFiles: CONFIG_FILES,
        });
        handled = harness.deliver(
          "push",
          pushContext(octokit.octokit, {
            ref: "refs/heads/main",
            changed: ["docs/woodhouse.yml"],
          }),
        );
        expect(handled).toBeInstanceOf(Promise);
      });
      When(`the push delivery is handled`, async () => {
        await requireValue(handled, "push delivery");
      });
      Then(
        `the routine re-check writes nothing when the repository already matches its configuration`,
        () => {
          expect(calls).toEqual(["push:repos.get"]);
        },
      );
      And(`no outcome comment is left`, () => {
        const surface = requireValue(octokit, "fake octokit");
        expect(surface.paginate).not.toHaveBeenCalledWith(
          surface.listComments,
          expect.anything(),
        );
        expect(surface.listComments).not.toHaveBeenCalled();
        expect(surface.createComment).not.toHaveBeenCalled();
        expect(surface.updateComment).not.toHaveBeenCalled();
      });
    },
  );

  ScenarioOutline(
    `A resolution that fails the gate is never synced`,
    ({ Given, When, Then, And }, variables) => {
      let resolved: ResolvedConfig | undefined;
      let built: ReturnType<typeof makeApplyOctokit> | undefined;
      let log: Logger | undefined;
      let ctx: ApplyContext | undefined;
      let summary: Awaited<ReturnType<typeof syncSettings>> | undefined;

      Given(`a resolved configuration <condition>`, () => {
        const condition = readCell(variables, "condition");
        const base = { settings: { enabled: true }, repository: { has_issues: true } };

        switch (condition) {
          case "without a local settings file":
            resolved = resolvedConfig(base, { localSource: undefined });
            break;
          case "with settings management disabled":
            resolved = resolvedConfig({ settings: { enabled: false } });
            break;
          case "with validation issues":
            resolved = resolvedConfig(base, {
              issues: [{ path: "settings.enabled", message: "bad" }],
            });
            break;
          default:
            throw new Error(`Unrecognised resolution condition: ${JSON.stringify(condition)}`);
        }

        built = makeApplyOctokit();
        log = fakeLogger();
        ctx = applyContext(built.octokit, log);
        expect(resolved).toBeDefined();
      });
      When(`the settings sync runs`, async () => {
        summary = await syncSettings(
          requireValue(ctx, "apply context"),
          requireValue(resolved, "resolved configuration"),
        );
      });
      Then(`no settings are written`, () => {
        expect(requireValue(summary, "apply summary")).toEqual({
          changes: [],
          failures: [],
          dryRun: false,
        });
        expect(requireValue(built, "fake octokit").calls).toEqual([]);
      });
      And(`the sync is skipped because "<reason>"`, () => {
        expect(requireValue(log, "logger").debug).toHaveBeenCalledWith(
          { reason: readCell(variables, "reason") },
          "Settings sync skipped",
        );
      });
    },
  );

  Scenario(`A local settings file opts the repository in`, ({ Given, When, Then, And }) => {
    let built: ReturnType<typeof makeApplyOctokit> | undefined;
    let ctx: ApplyContext | undefined;
    let resolved: ResolvedConfig | undefined;
    let summary: Awaited<ReturnType<typeof syncSettings>> | undefined;

    Given(`a resolved configuration from a local settings file`, () => {
      built = makeApplyOctokit({ current: { has_issues: false } });
      const log = fakeLogger();
      resolved = resolvedConfig({ repository: { has_issues: true } });
      ctx = applyContext(built.octokit, log);

      expect(resolved.config.settings.enabled).toBe(true);
      expect(resolved.localSource).toBeDefined();
    });
    When(`the settings sync runs`, async () => {
      summary = await syncSettings(
        requireValue(ctx, "apply context"),
        requireValue(resolved, "resolved configuration"),
      );
    });
    Then(`the appliers run in their declared order`, () => {
      expect(requireValue(built, "fake octokit").calls).toEqual(["repos.get", "repos.update"]);
    });
    And(`the summary lists the applied changes`, () => {
      expect(requireValue(summary, "apply summary").changes).toEqual([
        { area: "repository", action: "update", target: "has_issues" },
      ]);
    });
  });

  Scenario(`Rulesets converge by re-declaration`, ({ Given, When, Then, And }) => {
    let built: ReturnType<typeof makeApplyOctokit> | undefined;
    let ctx: ApplyContext | undefined;
    let resolved: ResolvedConfig | undefined;
    let summary: Awaited<ReturnType<typeof syncSettings>> | undefined;

    Given(`a repository whose rulesets already match the configured rulesets`, () => {
      built = makeApplyOctokit({ existingRulesets: [{ id: 42, name: "main" }] });
      const log = fakeLogger();
      resolved = resolvedConfig({ settings: { enabled: true }, rulesets: [{ name: "main" }] });
      ctx = applyContext(built.octokit, log);
    });
    When(`the settings sync runs`, async () => {
      summary = await syncSettings(
        requireValue(ctx, "apply context"),
        requireValue(resolved, "resolved configuration"),
      );
    });
    Then(`each configured ruleset is re-declared with an idempotent update`, () => {
      const fake = requireValue(built, "fake octokit");
      expect(fake.request).toHaveBeenCalledOnce();
      expect(fake.request).toHaveBeenCalledWith(
        "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
        expect.objectContaining({ ruleset_id: 42 }),
      );
    });
    And(`the summary reports a ruleset update for each configured ruleset`, () => {
      expect(requireValue(summary, "apply summary").changes).toContainEqual({
        area: "ruleset",
        action: "update",
        target: "main",
      });
    });
  });

  Scenario(
    `Branch protection converges by re-declaration`,
    ({ Given, When, Then, And }) => {
      let built: ReturnType<typeof makeApplyOctokit> | undefined;
      let ctx: ApplyContext | undefined;
      let resolved: ResolvedConfig | undefined;
      let summary: Awaited<ReturnType<typeof syncSettings>> | undefined;

      Given(`branch protection configured for branches whose protection already matches`, () => {
        built = makeApplyOctokit();
        const log = fakeLogger();
        resolved = resolvedConfig({ branchProtection: { main: {} } });
        ctx = applyContext(built.octokit, log);
      });
      When(`the settings sync runs`, async () => {
        summary = await syncSettings(
          requireValue(ctx, "apply context"),
          requireValue(resolved, "resolved configuration"),
        );
      });
      Then(`protection for each configured branch is re-declared`, () => {
        const fake = requireValue(built, "fake octokit");
        expect(fake.updateBranchProtection).toHaveBeenCalledOnce();
        expect(fake.updateBranchProtection).toHaveBeenCalledWith(
          expect.objectContaining({ branch: "main" }),
        );
      });
      And(`the summary reports a branch-protection update row per branch`, () => {
        expect(requireValue(summary, "apply summary").changes).toContainEqual({
          area: "branch-protection",
          action: "update",
          target: "main",
        });
      });
    },
  );

  Scenario(
    `A removed branchProtection block stops the re-assertion`,
    ({ Given, When, Then, And }) => {
      let built: ReturnType<typeof makeApplyOctokit> | undefined;
      let ctx: ApplyContext | undefined;
      let resolved: ResolvedConfig | undefined;
      let summary: Awaited<ReturnType<typeof syncSettings>> | undefined;

      Given(
        `a configuration that no longer lists a branchProtection block whose protection was previously applied`,
        () => {
          built = makeApplyOctokit();
          const log = fakeLogger();
          resolved = resolvedConfig({ settings: { enabled: true } });
          ctx = applyContext(built.octokit, log);

          expect(resolved.config.branchProtection).toEqual({});
        },
      );
      When(`the settings sync runs`, async () => {
        summary = await syncSettings(
          requireValue(ctx, "apply context"),
          requireValue(resolved, "resolved configuration"),
        );
      });
      Then(`nothing is re-asserted for that branch`, () => {
        const fake = requireValue(built, "fake octokit");
        expect(fake.updateBranchProtection).not.toHaveBeenCalled();
        expect(fake.request).not.toHaveBeenCalled();
      });
      And(`the branch's existing protection is not removed`, () => {
        expect(requireValue(summary, "apply summary").changes).toEqual([]);
      });
    },
  );

  Scenario(`A merge push and the merged event are serialised per repository`, ({ Given, When, Then }) => {
    let calls: string[] = [];
    let gate: Gate | undefined;
    let push: Promise<void> | undefined;
    let closed: Promise<void> | undefined;

    Given(
      `a merge push delivery and the merged pull request delivery for the same repository nearly simultaneously`,
      () => {
        const { app, deliver } = fakeProbot();
        createApp({
          allowlist: new Allowlist(["trusted-org"]),
          baselineRepo: ".github-private",
          dryRun: false,
        })(app);

        gate = manualGate();
        const pushOctokit = makeAppOctokit({
          label: "push",
          calls,
          gate,
          configFiles: CONFIG_FILES,
        });
        const closedOctokit = makeAppOctokit({
          label: "closed",
          calls,
          gate,
          configFiles: CONFIG_FILES,
        });

        // Fire both without awaiting: whichever reaches its first applier read
        // first claims the gate, and the shared mutex holds the other back.
        push = deliver("push", pushContext(pushOctokit.octokit));
        closed = deliver("pull_request.closed", closedContext(closedOctokit.octokit));
        expect(push).toBeInstanceOf(Promise);
        expect(closed).toBeInstanceOf(Promise);
      },
    );
    When(`both syncs run`, async () => {
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/:repos\.get$/);
    });
    Then(`the two syncs run in some order without interleaving`, async () => {
      requireValue(gate, "manual gate").release();
      await Promise.all([
        requireValue(push, "push delivery"),
        requireValue(closed, "closed delivery"),
      ]);

      const pushBatch = ["push:repos.get", "push:repos.update"];
      const closedBatch = ["closed:repos.get", "closed:repos.update"];

      expect([
        [...pushBatch, ...closedBatch],
        [...closedBatch, ...pushBatch],
      ]).toContainEqual(calls);
    });
  });
});
