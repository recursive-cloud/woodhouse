import { describe, expect, it, vi } from "vitest";
import { getPullRequest, listChangedFiles, type ChangedFile } from "../src/github/pulls.js";

type Octokit = Parameters<typeof listChangedFiles>[0];

/** `count` files starting at index `from`, as a full or partial page. */
function pageOf(count: number, from = 0): ChangedFile[] {
  return Array.from({ length: count }, (_, i) => ({
    filename: `file-${from + i}.txt`,
    status: "added",
  }));
}

function fakeOctokit(pages: ChangedFile[][]) {
  const listFiles = vi.fn(async (params: { page?: number }) => ({
    data: pages[(params.page ?? 1) - 1] ?? [],
  }));

  const get = vi.fn(async (params: { pull_number: number }) => ({
    data: { number: params.pull_number, title: "the pull request" },
  }));

  // Mirrors octokit.paginate: call the route per page until a short page.
  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: ChangedFile[] }>,
      params: Record<string, unknown>,
    ) => {
      const out: ChangedFile[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        out.push(...data);
        if (data.length < ((params.per_page as number | undefined) ?? 100)) break;
      }
      return out;
    },
  );

  const octokit = { pulls: { listFiles, get }, paginate } as unknown as Octokit;
  return { octokit, listFiles, get, paginate };
}

describe("listChangedFiles", () => {
  it("walks every page and concatenates the results", async () => {
    const { octokit, paginate } = fakeOctokit([pageOf(100, 0), pageOf(100, 100), pageOf(5, 200)]);

    const result = await listChangedFiles(octokit, "acme", "widgets", 7);

    expect(result.files).toHaveLength(205);
    expect(result.files[0]?.filename).toBe("file-0.txt");
    expect(result.files[204]?.filename).toBe("file-204.txt");
    expect(result.truncated).toBe(false);
    expect(paginate).toHaveBeenCalledWith(expect.anything(), {
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      per_page: 100,
    });
  });

  it("passes owner, repo and number through on every page", async () => {
    const { octokit, listFiles } = fakeOctokit([pageOf(100, 0), pageOf(100, 100)]);

    await listChangedFiles(octokit, "acme", "widgets", 7, { maxPages: 2 });

    expect(listFiles).toHaveBeenNthCalledWith(1, {
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      per_page: 100,
      page: 1,
    });
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      owner: "acme",
      repo: "widgets",
      pull_number: 7,
      per_page: 100,
      page: 2,
    });
  });

  it("sets truncated at the cap when more pages may remain", async () => {
    const { octokit, listFiles } = fakeOctokit([
      pageOf(100, 0),
      pageOf(100, 100),
      pageOf(100, 200),
    ]);

    const result = await listChangedFiles(octokit, "acme", "widgets", 7, { maxPages: 2 });

    expect(result.files).toHaveLength(200);
    expect(result.truncated).toBe(true);
    // Bounded: never fetches the page past the cap.
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("does not truncate when a short page ends the listing before the cap", async () => {
    const { octokit } = fakeOctokit([pageOf(100, 0), pageOf(3, 100)]);

    const result = await listChangedFiles(octokit, "acme", "widgets", 7, { maxPages: 5 });

    expect(result.files).toHaveLength(103);
    expect(result.truncated).toBe(false);
  });

  it("preserves the old path of a renamed file", async () => {
    const { octokit } = fakeOctokit([
      [{ filename: "new.ts", status: "renamed", previous_filename: "old.ts" }],
    ]);

    const result = await listChangedFiles(octokit, "acme", "widgets", 7);

    expect(result.files[0]).toEqual({
      filename: "new.ts",
      status: "renamed",
      previous_filename: "old.ts",
    });
  });
});

describe("getPullRequest", () => {
  it("fetches the pull request and returns its data", async () => {
    const { octokit, get } = fakeOctokit([]);

    const pr = await getPullRequest(octokit, "acme", "widgets", 7);

    expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", pull_number: 7 });
    expect(pr).toEqual({ number: 7, title: "the pull request" });
  });
});
