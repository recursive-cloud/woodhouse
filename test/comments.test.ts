import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { syncMarkerComment } from "../src/github/comments.js";

type Deps = Parameters<typeof syncMarkerComment>[0];
type Octokit = Deps["octokit"];

interface Comment {
  id: number;
  body?: string;
}

/**
 * Fake octokit covering only the surfaces the manager depends on: paginated
 * issue-comment listing plus the three write routes. Mirrors `octokit.paginate`
 * by invoking the supplied route once.
 */
function fakeOctokit(comments: Comment[]) {
  const listComments = vi.fn(async () => ({ data: comments }));
  const createComment = vi.fn(async () => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async () => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: Comment[] }>,
      params: Record<string, unknown>,
    ) => {
      const { data } = await route({ ...params });
      return data;
    },
  );

  const octokit = {
    issues: { listComments, createComment, updateComment, deleteComment },
    paginate,
  } as unknown as Octokit;

  return { octokit, paginate, listComments, createComment, updateComment, deleteComment };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

const marker = "<!-- woodhouse:test -->";

function build(comments: Comment[] = [], dryRun = false) {
  const octokit = fakeOctokit(comments);
  const log = fakeLogger();
  const deps = { octokit: octokit.octokit, log, dryRun } as unknown as Deps;
  return { deps, log, ...octokit };
}

const options = { owner: "acme", repo: "widgets", issueNumber: 7, marker };

describe("syncMarkerComment", () => {
  it("creates the comment when none carries the marker", async () => {
    const { deps, paginate, createComment, updateComment, deleteComment } = build([]);

    await syncMarkerComment(deps, { ...options, body: "the body" });

    expect(paginate).toHaveBeenCalledWith(expect.anything(), {
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      per_page: 100,
    });
    expect(createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
      body: "the body",
    });
    expect(updateComment).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
  });

  it("updates in place when a comment carrying the marker already exists", async () => {
    const { deps, createComment, updateComment } = build([
      { id: 42, body: `before ${marker} after` },
    ]);

    await syncMarkerComment(deps, { ...options, body: "new body" });

    expect(updateComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      comment_id: 42,
      body: "new body",
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("finds the comment by marker, not by author or position", async () => {
    const { deps, updateComment } = build([
      { id: 10, body: "a human comment" },
      { id: 11, body: `quoted ${marker} by someone` },
    ]);

    await syncMarkerComment(deps, { ...options, body: "new body" });

    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 11 }));
  });

  it("deletes the comment when body is undefined and one exists", async () => {
    const { deps, createComment, updateComment, deleteComment } = build([{ id: 42, body: marker }]);

    await syncMarkerComment(deps, { ...options, body: undefined });

    expect(deleteComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      comment_id: 42,
    });
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("writes nothing when the desired state already holds", async () => {
    const { deps, paginate, createComment, updateComment, deleteComment } = build([]);

    await syncMarkerComment(deps, { ...options, body: undefined });

    expect(paginate).toHaveBeenCalledOnce();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
  });

  it("in dry-run makes zero octokit calls and logs a DRY_RUN line", async () => {
    const { deps, log, paginate, listComments, createComment, updateComment, deleteComment } =
      build([{ id: 42, body: marker }], true);

    await syncMarkerComment(deps, { ...options, body: "the body" });

    expect(paginate).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("DRY_RUN"));
  });
});
