import { describe, expect, it, vi } from "vitest";
import type { Context } from "probot";
import { createApp } from "../src/app.js";
import { Allowlist } from "../src/security/allowlist.js";
import { GuardedApp, type EventScope } from "../src/security/guard.js";
import { DRESS_CODE_CHECK_NAME } from "../src/dresscode/constants.js";
import { makeOctokit } from "../features/settings-sync/octokit-fakes.js";
import { fakeProbot } from "../features/settings-sync/probot-fakes.js";
import { fakeLogger } from "../features/support/scenario.js";

/**
 * App-level coverage for the three dress-code listeners `createApp` registers.
 *
 * The registration test follows the silver-platter pattern: spy on
 * `GuardedApp.prototype.on` and assert the event/name pairs. The behaviour
 * tests then invoke just the captured dress-code handler, so the other
 * listeners on the same event never run and the octokit fake only needs the
 * surfaces dress-code touches.
 */

const OWNER = "trusted-org";
const REPO = "widgets";
const SHA = "1111111111111111111111111111111111111111";

/** The local layer that opts this fake repository into dress-code. */
const CONFIG_FILES = {
  [`${REPO}:.github/woodhouse.yml`]: "dressCode:\n  enabled: true\n",
};

type CapturedHandler = (context: unknown, scope: EventScope) => Promise<void> | void;

interface CapturedRegistration {
  readonly events: readonly string[];
  readonly name: string;
  readonly handler: CapturedHandler;
}

function captureRegistrations(): readonly CapturedRegistration[] {
  const { app } = fakeProbot();
  const spy = vi.spyOn(GuardedApp.prototype, "on");

  try {
    createApp({
      allowlist: new Allowlist([OWNER]),
      baselineRepo: ".github-private",
      dryRun: false,
    })(app);

    return spy.mock.calls.map(([events, name, handler]) => ({
      events: Array.isArray(events) ? events : [events],
      name,
      handler: handler as unknown as CapturedHandler,
    }));
  } finally {
    spy.mockRestore();
  }
}

function dressCodeHandler(
  registrations: readonly CapturedRegistration[],
  event: string,
): CapturedHandler {
  const registration = registrations.find(
    (candidate) => candidate.name === "dress-code" && candidate.events.includes(event),
  );
  if (registration === undefined) {
    throw new Error(`No dress-code handler registered for ${event}`);
  }
  return registration.handler;
}

function scopeFor(event: string): EventScope {
  return {
    owner: OWNER,
    repo: REPO,
    deliveryId: "delivery-dress-code",
    event,
    log: fakeLogger(),
  };
}

/** The Checks and Contents surfaces dress-code reaches, over the shared config fake. */
function buildOctokit() {
  const base = makeOctokit({ configFiles: CONFIG_FILES });

  const create = vi.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
  const update = vi.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
  const listForRef = vi.fn(async (_params: Record<string, unknown>) => ({
    data: { check_runs: [] },
  }));
  const listPullRequestsAssociatedWithCommit = vi.fn(async (_params: Record<string, unknown>) => ({
    data: [],
  }));

  const octokit = {
    ...base.octokit,
    checks: { create, update, listForRef },
    repos: { ...base.octokit.repos, listPullRequestsAssociatedWithCommit },
  } as unknown as Context<"pull_request">["octokit"];

  return { octokit, create, update, listForRef, listPullRequestsAssociatedWithCommit };
}

interface PullRequestContextOptions {
  readonly action: string;
  readonly title: string;
  readonly changes?: Record<string, unknown>;
}

function pullRequestContext(
  octokit: Context<"pull_request">["octokit"],
  options: PullRequestContextOptions,
) {
  return {
    name: "pull_request",
    id: "delivery-dress-code",
    log: fakeLogger(),
    octokit,
    payload: {
      action: options.action,
      ...(options.changes === undefined ? {} : { changes: options.changes }),
      pull_request: {
        number: 12,
        title: options.title,
        head: { sha: SHA },
        base: { ref: "main" },
        state: "open",
        draft: false,
        user: { login: "contributor" },
      },
      repository: {
        name: REPO,
        default_branch: "main",
        owner: { login: OWNER },
      },
    },
  };
}

function rerequestContext(octokit: Context<"pull_request">["octokit"], checkName: string) {
  return {
    name: "check_run",
    id: "delivery-dress-code",
    log: fakeLogger(),
    octokit,
    payload: {
      action: "rerequested",
      check_run: { name: checkName, head_sha: SHA },
      repository: {
        name: REPO,
        default_branch: "main",
        owner: { login: OWNER },
      },
    },
  };
}

describe("createApp — dress-code listener coverage", () => {
  it("registers all four dress-code events under the guarded name", () => {
    const registrations = captureRegistrations();

    const registered = new Set(
      registrations
        .filter((registration) => registration.name === "dress-code")
        .flatMap((registration) => registration.events),
    );

    expect(registered).toEqual(
      new Set([
        "pull_request.opened",
        "pull_request.synchronize",
        "pull_request.edited",
        "check_run.rerequested",
      ]),
    );
  });
});

describe("dress-code handler — pull_request.edited", () => {
  it("re-runs the check when the title changes", async () => {
    const handler = dressCodeHandler(captureRegistrations(), "pull_request.edited");
    const { octokit, create, update } = buildOctokit();

    await handler(
      pullRequestContext(octokit, {
        action: "edited",
        title: "quick fix",
        changes: { title: { from: "feat: add an environments section" } },
      }),
      scopeFor("pull_request"),
    );

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: DRESS_CODE_CHECK_NAME,
        head_sha: SHA,
        conclusion: "failure",
      }),
    );
  });

  it("writes no check for a body-only edit", async () => {
    const handler = dressCodeHandler(captureRegistrations(), "pull_request.edited");
    const { octokit, create, update, listForRef } = buildOctokit();

    await handler(
      pullRequestContext(octokit, {
        action: "edited",
        title: "feat: add an environments section",
        changes: { body: { from: "the old description" } },
      }),
      scopeFor("pull_request"),
    );

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(listForRef).not.toHaveBeenCalled();
  });
});

describe("dress-code handler — check_run.rerequested", () => {
  it("ignores a re-request for a run with a foreign name", async () => {
    const handler = dressCodeHandler(captureRegistrations(), "check_run.rerequested");
    const { octokit, create, update, listForRef, listPullRequestsAssociatedWithCommit } =
      buildOctokit();

    await handler(rerequestContext(octokit, "ci/build"), scopeFor("check_run"));

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(listForRef).not.toHaveBeenCalled();
    expect(listPullRequestsAssociatedWithCommit).not.toHaveBeenCalled();
  });
});
