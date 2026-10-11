import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { resetAppLoginCache, serve } from "../src/approval/silverPlatter.js";
import { autoApprovalSchema, type AutoApprovalConfig } from "../src/config/schema.js";

type Deps = Parameters<typeof serve>[0];

const config: AutoApprovalConfig = autoApprovalSchema.parse({ allowedActors: ["renovate[bot]"] });

const pr = {
  number: 7,
  author: "renovate[bot]",
  draft: false,
  state: "open",
  headSha: "abc123",
};

/** `count` changed files starting at index `from`. */
function pageOf(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `file-${from + i}.txt`,
    status: "added",
  }));
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function harness(filePages: ReturnType<typeof pageOf>[]) {
  const listFiles = vi.fn(async (params: { page?: number }) => ({
    data: filePages[(params.page ?? 1) - 1] ?? [],
  }));

  const listReviews = vi.fn(async () => ({ data: [] as unknown[] }));

  const createReview = vi.fn(async () => ({ data: {} }));

  // Mirrors octokit.paginate: call the route per page until a short page.
  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
    ) => {
      const out: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        out.push(...data);
        if (data.length < ((params.per_page as number | undefined) ?? 100)) break;
      }
      return out;
    },
  );

  const octokit = {
    pulls: { listFiles, listReviews, createReview },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
    paginate,
  } as unknown as Deps["octokit"];

  return { octokit, log: fakeLogger(), listFiles, listReviews, createReview };
}

beforeEach(() => {
  // appLogin is cached per process; each test owns a fresh fake octokit.
  resetAppLoginCache();
});

describe("serve", () => {
  it("approves an eligible untruncated listing, pinned to the head SHA", async () => {
    const h = harness([pageOf(3)]);

    const approved = await serve(
      { octokit: h.octokit, log: h.log, dryRun: false },
      "acme",
      "widgets",
      pr,
      config,
    );

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledOnce();
    expect(h.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        pull_number: 7,
        event: "APPROVE",
        commit_id: "abc123",
      }),
    );
    expect(h.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", pull_number: 7 }),
    );
  });

  it("refuses a listing truncated at the cap, with no review submitted", async () => {
    // The safety cap is 10 pages; 10 full pages means there may be more.
    const h = harness(Array.from({ length: 10 }, (_, p) => pageOf(100, p * 100)));

    const approved = await serve(
      { octokit: h.octokit, log: h.log, dryRun: false },
      "acme",
      "widgets",
      pr,
      config,
    );

    expect(approved).toBe(false);
    expect(h.listFiles).toHaveBeenCalledTimes(10);
    expect(h.createReview).not.toHaveBeenCalled();
  });
});
