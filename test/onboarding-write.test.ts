import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import {
  ONBOARDING_COMMIT_MESSAGE,
  openOnboardingPullRequest,
  type OnboardingFacts,
  type OnboardingWriteDeps,
} from "../src/onboarding/write.js";
import {
  ONBOARDING_BRANCH,
  ONBOARDING_FILE_PATH,
  ONBOARDING_LABEL,
  ONBOARDING_PR_BODY,
  ONBOARDING_PR_TITLE,
  ONBOARDING_TEMPLATE,
} from "../src/onboarding/wording.js";

/**
 * Recording fake octokit.
 *
 * Every method the seam could reach pushes its name onto `calls` in invocation
 * order — reads included — so "dry-run issues zero calls" is a literal
 * assertion over the whole surface, not just the writes the seam happens to
 * reach today. `git.getRef` is exercised below precisely because the seam must
 * never reach it: the facts it would have to read are pre-resolved, so any
 * read here would break the zero-calls guarantee. `pulls.create` returns a
 * number the label call must reuse.
 */
function fakeOctokit() {
  const calls: string[] = [];

  const getRef = vi.fn(async () => {
    calls.push("git.getRef");
    return { data: { object: { sha: "read-not-written" } } };
  });
  const createRef = vi.fn(async () => {
    calls.push("git.createRef");
    return { data: {} };
  });
  const createOrUpdateFileContents = vi.fn(async () => {
    calls.push("repos.createOrUpdateFileContents");
    return { data: {} };
  });
  const create = vi.fn(async () => {
    calls.push("pulls.create");
    return { data: { number: 42 } };
  });
  const addLabels = vi.fn(async () => {
    calls.push("issues.addLabels");
    return { data: [] };
  });

  const octokit = {
    git: { getRef, createRef },
    repos: { createOrUpdateFileContents },
    pulls: { create },
    issues: { addLabels },
  } as unknown as OnboardingWriteDeps["octokit"];

  return { octokit, calls, getRef, createRef, createOrUpdateFileContents, create, addLabels };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  defaultBranch: "main",
  defaultBranchSha: "abc1234",
  branchExists: false,
  ...overrides,
});

function build(dryRun = false, factOverrides: Partial<OnboardingFacts> = {}) {
  const fake = fakeOctokit();
  const log = fakeLogger();
  const deps = {
    octokit: fake.octokit,
    log: log as unknown as Logger,
    dryRun,
  } as OnboardingWriteDeps;

  return { ...fake, log, deps, facts: facts(factOverrides) };
}

describe("openOnboardingPullRequest", () => {
  it("issues ref → contents → pull request → label, in order, with the facts' arguments", async () => {
    // A non-default branch name proves `base` comes from the facts, not a
    // hardcoded "main".
    const {
      deps,
      facts: f,
      calls,
      getRef,
      createRef,
      createOrUpdateFileContents,
      create,
      addLabels,
    } = build(false, { defaultBranch: "trunk" });

    const result = await openOnboardingPullRequest(deps, "acme", "widgets", f);

    // The facts include the head SHA, so the seam must not read it back.
    expect(getRef).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "git.createRef",
      "repos.createOrUpdateFileContents",
      "pulls.create",
      "issues.addLabels",
    ]);

    expect(createRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      ref: `refs/heads/${ONBOARDING_BRANCH}`,
      sha: "abc1234",
    });

    expect(createOrUpdateFileContents).toHaveBeenCalledOnce();
    const contentsArg = createOrUpdateFileContents.mock.calls[0]![0];
    expect(contentsArg).toMatchObject({
      owner: "acme",
      repo: "widgets",
      path: ONBOARDING_FILE_PATH,
      branch: ONBOARDING_BRANCH,
      message: ONBOARDING_COMMIT_MESSAGE,
    });
    expect(Buffer.from(contentsArg.content, "base64").toString("utf8")).toBe(ONBOARDING_TEMPLATE);
    // Conventional Commits, so the host repository's history stays clean.
    expect(ONBOARDING_COMMIT_MESSAGE).toMatch(/^chore: /);

    expect(create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      title: ONBOARDING_PR_TITLE,
      head: ONBOARDING_BRANCH,
      base: "trunk",
      body: ONBOARDING_PR_BODY,
    });

    expect(addLabels).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      labels: [ONBOARDING_LABEL],
    });

    expect(result).toEqual({ pullRequestNumber: 42 });
  });

  it("issues zero octokit calls in dry-run and logs the would-be pull request", async () => {
    const { deps, facts: f, calls, getRef, log } = build(true);

    const result = await openOnboardingPullRequest(deps, "acme", "widgets", f);

    // Zero calls must hold for reads too, not just writes.
    expect(getRef).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(result).toEqual({});

    // The whole would-be pull request — branch, file, title and full body —
    // appears in the captured log output, with zero calls above.
    expect(log.info).toHaveBeenCalledWith(
      {
        branch: ONBOARDING_BRANCH,
        file: ONBOARDING_FILE_PATH,
        title: ONBOARDING_PR_TITLE,
        body: ONBOARDING_PR_BODY,
      },
      expect.stringContaining("DRY_RUN: would open onboarding pull request"),
    );

    // The branch, file and title also ride the per-write DRY_RUN lines.
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`DRY_RUN: would create branch ${ONBOARDING_BRANCH}`),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`DRY_RUN: would open pull request "${ONBOARDING_PR_TITLE}"`),
    );
  });

  it("opens from an existing branch without rewriting it", async () => {
    const {
      deps,
      facts: f,
      calls,
      getRef,
      createRef,
      createOrUpdateFileContents,
      create,
      addLabels,
    } = build(false, { branchExists: true });

    const result = await openOnboardingPullRequest(deps, "acme", "widgets", f);

    // `branchExists` arrives on the facts; the seam does not probe for it.
    expect(getRef).not.toHaveBeenCalled();
    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(calls).toEqual(["pulls.create", "issues.addLabels"]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ head: ONBOARDING_BRANCH, base: "main" }),
    );
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, labels: [ONBOARDING_LABEL] }),
    );
    expect(result).toEqual({ pullRequestNumber: 42 });
  });

  it("propagates an error from a write rather than swallowing it", async () => {
    const { deps, facts: f, createRef } = build(false);
    createRef.mockRejectedValueOnce(new Error("Resource not accessible by integration"));

    await expect(openOnboardingPullRequest(deps, "acme", "widgets", f)).rejects.toThrow(
      "Resource not accessible by integration",
    );
  });
});
