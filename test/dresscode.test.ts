import { describe, expect, it } from "vitest";
import {
  decideDressCode,
  reRequestDressCodeCheck,
  runDressCodeCheck,
} from "../src/dresscode/check.js";
import {
  DRESS_CODE_CHECK_NAME,
  DRESS_CODE_DISABLED_REASON,
  DRESS_CODE_NO_PULL_REQUEST_REASON,
} from "../src/dresscode/constants.js";
import { titlePatternDescription } from "../src/conventional/parse.js";
import { NEW_SHA, OWNER, REPO, SHA, build, storedRun } from "./dresscode-harness.js";

const CONVENTIONAL_TITLES = [
  "feat(settings): add the environments section",
  "feat: add an environments section",
  "fix: handle the empty payload",
] as const;

const NON_CONVENTIONAL_TITLES = [
  "updated the readme",
  "WIP",
  "FIX: urgent",
  "feat: ",
  // Untrimmed input is a violation, not something the check repairs.
  " feat: leading space",
] as const;

describe("decideDressCode — the pure verdict", () => {
  it.each(CONVENTIONAL_TITLES)("accepts %j", (title) => {
    const decision = decideDressCode(title);

    expect(decision.outcome).toBe("success");
    expect(decision.output.title).toContain("conventional");
    expect(decision.output.summary).not.toBe("");
  });

  it.each(NON_CONVENTIONAL_TITLES)("rejects %j with guidance", (title) => {
    const decision = decideDressCode(title);

    expect(decision.outcome).toBe("failure");
    expect(decision.output.summary).toContain(titlePatternDescription());
    expect(decision.output.summary).toContain(JSON.stringify(title));
  });
});

describe("runDressCodeCheck", () => {
  it("creates a completed run on the head commit for a matching title", async () => {
    const { deps, create, update, listForRef } = build();

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "feat: add an environments section",
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        name: DRESS_CODE_CHECK_NAME,
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        output: expect.objectContaining({
          title: expect.stringContaining("conventional"),
          summary: expect.any(String),
        }),
      }),
    );
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: SHA,
        check_name: DRESS_CODE_CHECK_NAME,
        filter: "latest",
      }),
    );
  });

  it("reports failure naming the expected pattern and the offending title", async () => {
    const { deps, create } = build();

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "updated the readme",
    });

    const body = create.mock.calls[0]?.[0] as {
      conclusion: string;
      output: { summary: string };
    };
    expect(body.conclusion).toBe("failure");
    expect(body.output.summary).toContain(titlePatternDescription());
    expect(body.output.summary).toContain(JSON.stringify("updated the readme"));
  });

  it("caps a failure summary that would exceed GitHub's output limit", async () => {
    const { deps, create } = build();
    const title = "y".repeat(70_000);

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title,
    });

    const body = create.mock.calls[0]?.[0] as { output: { summary: string } };
    expect(body.output.summary.length).toBeLessThanOrEqual(65_535);
    expect(body.output.summary.endsWith("\n\n_(truncated)_")).toBe(true);
  });

  it("performs no writes at all when dress-code is disabled", async () => {
    const { deps, create, update, listForRef, log } = build({ enabled: false });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "quick fix",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(listForRef).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { sha: SHA },
      "Dress-code disabled by configuration; skipping",
    );
  });

  it("performs no GitHub writes in dry-run and logs the skipped write", async () => {
    const { deps, create, update, listForRef, log } = build({ dryRun: true });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "feat: add an environments section",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // `performWrite` returns before the existing-run lookup too.
    expect(listForRef).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("DRY_RUN: would write dress-code check");
  });

  it("updates an existing completed run in place instead of creating another", async () => {
    const { deps, create, update } = build({ runs: [storedRun()] });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      title: "quick fix",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    const body = update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        name: DRESS_CODE_CHECK_NAME,
        check_run_id: 77,
        status: "completed",
        conclusion: "failure",
      }),
    );
    // `head_sha` is create-only; GitHub's update endpoint has no such field.
    expect(body).not.toHaveProperty("head_sha");
  });

  it("creates a fresh run for a new head commit", async () => {
    const { deps, create, update } = build({ runs: [storedRun()] });

    await runDressCodeCheck(deps, {
      owner: OWNER,
      repo: REPO,
      sha: NEW_SHA,
      title: "feat: add an environments section",
    });

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ head_sha: NEW_SHA }));
  });
});

describe("reRequestDressCodeCheck", () => {
  it("writes nothing when enabled and no dress-code run exists", async () => {
    const { deps, create, update, log, paginate } = build({
      pullRequests: [
        {
          number: 12,
          state: "open",
          title: "feat: add an environments section",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    // A whole-suite re-run can arrive for any commit, including one that never
    // carried a dress-code run. Completing a run that does not exist would
    // create a check the operator never enabled.
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(paginate).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { sha: SHA },
      "No dress-code run to re-request; skipping",
    );
  });

  it("writes nothing when disabled and no dress-code run exists", async () => {
    const { deps, create, update } = build({ enabled: false });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("completes a queued run using the title of the associated pull request", async () => {
    const { deps, create, update } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 12,
          state: "open",
          title: "feat: add an environments section",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 77,
        status: "completed",
        conclusion: "success",
      }),
    );
  });

  it("reads every page of associated pull requests through the paginator", async () => {
    const { deps, update, paginate, listPullRequestsAssociatedWithCommit } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 12,
          state: "open",
          title: "feat: add an environments section",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(paginate).toHaveBeenCalledWith(
      listPullRequestsAssociatedWithCommit,
      expect.objectContaining({ commit_sha: SHA, per_page: 100 }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it("ignores pull requests whose head is not the requested commit", async () => {
    const { deps, update } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 2,
          state: "open",
          title: "WIP",
          head: { sha: NEW_SHA },
        },
        {
          number: 3,
          state: "open",
          title: "fix: handle the empty payload",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it("prefers an open pull request over a closed one", async () => {
    const { deps, update } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 1,
          state: "closed",
          title: "fix: handle the empty payload",
          head: { sha: SHA },
        },
        {
          number: 5,
          state: "open",
          title: "quick fix",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "failure" }));
  });

  it("tie-breaks matching open pull requests to the lowest number", async () => {
    const { deps, update } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 8,
          state: "open",
          title: "quick fix",
          head: { sha: SHA },
        },
        {
          number: 4,
          state: "open",
          title: "docs: explain the workflow",
          head: { sha: SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "success" }));
  });

  it("completes neutral when no pull request is headed by the commit", async () => {
    const { deps, create, update, listPullRequestsAssociatedWithCommit } = build({
      runs: [storedRun({ status: "queued", conclusion: null })],
      pullRequests: [
        {
          number: 9,
          state: "open",
          title: "feat: somewhere else",
          head: { sha: NEW_SHA },
        },
      ],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    expect(listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith(
      expect.objectContaining({ commit_sha: SHA }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "neutral" }));
    const body = update.mock.calls[0]?.[0] as {
      output: { summary: string };
    };
    expect(body.output.summary).toContain(DRESS_CODE_NO_PULL_REQUEST_REASON);
  });

  it("completes neutral with the disabled explanation when dress-code is off", async () => {
    const { deps, update, listPullRequestsAssociatedWithCommit } = build({
      enabled: false,
      runs: [storedRun({ status: "queued", conclusion: null })],
    });

    await reRequestDressCodeCheck(deps, OWNER, REPO, SHA);

    // The associated-PR lookup is not needed to explain a disabled check.
    expect(listPullRequestsAssociatedWithCommit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 77,
        status: "completed",
        conclusion: "neutral",
        output: expect.objectContaining({ summary: DRESS_CODE_DISABLED_REASON }),
      }),
    );
  });
});
