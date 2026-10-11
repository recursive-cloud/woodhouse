import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { resetAppLoginCache, serve } from "../src/approval/silverPlatter.js";
import { autoApprovalSchema, type AutoApprovalConfig } from "../src/config/schema.js";

type Deps = Parameters<typeof serve>[0];

/** Mirrors the module constant in silverPlatter.ts; the test pins the delay. */
const GRACE_MS = 2_000;

const botConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { bots: ["renovate[bot]"] },
});

const ownerConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { owners: ["my-user"] },
});

const SIGN_OFF = "_Woodhouse, at your service._";

const OWNER_BODY =
  "Very good, sir. Approving on your behalf — this pull request touches no protected paths.\n\n" +
  SIGN_OFF;

const BOT_BODY =
  "Sir, just letting you know I am letting the handyman in to fix a few things — " +
  "renovate[bot] asked to be merged and this pull request touches no protected paths.\n\n" +
  SIGN_OFF;

const pr = {
  number: 7,
  author: "renovate[bot]",
  draft: false,
  state: "open",
  headSha: "abc123",
  // Not `opened`, so the fixture does not trigger the auto-merge grace; tests
  // that exercise the grace override this explicitly.
  action: "synchronize",
};

/** The bot enabled auto-merge on its own pull request. */
const enabledBySelf = { enabled_by: { login: "renovate[bot]" } };

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

interface HarnessOptions {
  /** The `auto_merge` object the live GET returns; absent means no auto-merge. */
  readonly autoMerge?: { enabled_by: { login: string } } | null;
  /** When set, the live GET rejects with this error. */
  readonly getError?: Error;
  /** Existing reviews, for the idempotency case. */
  readonly reviews?: unknown[];
}

function harness(filePages: ReturnType<typeof pageOf>[], options: HarnessOptions = {}) {
  const listFiles = vi.fn(async (params: { page?: number }) => ({
    data: filePages[(params.page ?? 1) - 1] ?? [],
  }));

  const listReviews = vi.fn(async () => ({ data: options.reviews ?? ([] as unknown[]) }));

  const createReview = vi.fn(async () => ({ data: {} }));

  // The live pull request GET: this is the only source of the auto-merge fact.
  const get = vi.fn(async () => {
    if (options.getError !== undefined) throw options.getError;
    return { data: { auto_merge: options.autoMerge ?? null } };
  });

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
    pulls: { listFiles, listReviews, createReview, get },
    apps: { getAuthenticated: async () => ({ data: { slug: "woodhouse" } }) },
    paginate,
  } as unknown as Deps["octokit"];

  return { octokit, log: fakeLogger(), listFiles, listReviews, createReview, get };
}

function run(
  h: ReturnType<typeof harness>,
  authorClass: "bot" | "owner" = "bot",
  facts: Partial<typeof pr> = {},
  dryRun = false,
) {
  return serve(
    { octokit: h.octokit, log: h.log, dryRun },
    "acme",
    "widgets",
    { ...pr, author: authorClass === "owner" ? "my-user" : "renovate[bot]", ...facts },
    authorClass === "owner" ? ownerConfig : botConfig,
  );
}

beforeEach(() => {
  // appLogin is cached per process; each test owns a fresh fake octokit.
  resetAppLoginCache();
});

describe("serve", () => {
  it("approves an eligible untruncated listing, pinned to the head SHA, with the bot body", async () => {
    const h = harness([pageOf(3)], { autoMerge: enabledBySelf });

    const approved = await run(h);

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledOnce();
    expect(h.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        pull_number: 7,
        event: "APPROVE",
        commit_id: "abc123",
        body: BOT_BODY,
      }),
    );
    expect(h.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", pull_number: 7 }),
    );
  });

  it("refuses a listing truncated at the cap, with no review submitted", async () => {
    // The safety cap is 10 pages; 10 full pages means there may be more. The
    // bot's own auto-merge is present, so truncation is genuinely the reason.
    const h = harness(
      Array.from({ length: 10 }, (_, p) => pageOf(100, p * 100)),
      { autoMerge: enabledBySelf },
    );

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.listFiles).toHaveBeenCalledTimes(10);
    expect(h.createReview).not.toHaveBeenCalled();
  });
});

describe("serve — actor-class tailors the review body", () => {
  it("uses the owner body for an owner author", async () => {
    const h = harness([pageOf(1)]);

    const approved = await run(h, "owner");

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledWith(expect.objectContaining({ body: OWNER_BODY }));
  });

  it("names the author in the bot body", async () => {
    const h = harness([pageOf(1)], { autoMerge: enabledBySelf });

    await run(h);

    expect(h.createReview).toHaveBeenCalledWith(expect.objectContaining({ body: BOT_BODY }));
  });
});

describe("serve — auto-merge fact gathering", () => {
  it("fetches the live pull request for a bot author, but never for an owner", async () => {
    const botH = harness([pageOf(1)], { autoMerge: enabledBySelf });
    await run(botH);
    expect(botH.get).toHaveBeenCalledOnce();

    // An owner's approval never depends on auto-merge: no GET at all, even on
    // the action that would otherwise incur the grace.
    const ownerH = harness([pageOf(1)]);
    const approved = await run(ownerH, "owner", { action: "opened" });
    expect(approved).toBe(true);
    expect(ownerH.get).not.toHaveBeenCalled();
  });

  it("waits the grace on opened before fetching", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([pageOf(1)], { autoMerge: enabledBySelf });

      const pending = run(h, "bot", { action: "opened" });

      // The preliminary pass and the file listing settle without the GET.
      await vi.advanceTimersByTimeAsync(0);
      expect(h.get).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(h.get).toHaveBeenCalledOnce();
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches immediately on the other three actions", async () => {
    vi.useFakeTimers();
    try {
      for (const action of ["synchronize", "ready_for_review", "reopened"]) {
        const h = harness([pageOf(1)], { autoMerge: enabledBySelf });

        const pending = run(h, "bot", { action });

        await vi.advanceTimersByTimeAsync(0);
        expect(h.get, `action=${action}`).toHaveBeenCalledOnce();
        await expect(pending).resolves.toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a null fact when auto-merge is absent and declines after fetching", async () => {
    // The preliminary pass must not decline the bot for the missing fact:
    // otherwise the GET below would never fire. The full pass, with the
    // gathered null, is what declines.
    const h = harness([pageOf(1)]);

    const approved = await run(h);

    expect(h.get).toHaveBeenCalledOnce();
    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("declines when a different login enabled auto-merge", async () => {
    const h = harness([pageOf(1)], { autoMerge: { enabled_by: { login: "my-user" } } });

    const approved = await run(h);

    expect(h.get).toHaveBeenCalledOnce();
    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("fails the pass when the GET rejects — no approval, no silent null", async () => {
    const h = harness([pageOf(1)], { getError: new Error("boom") });

    await expect(run(h)).rejects.toThrow("boom");
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("is fail-safe on a late auto-merge toggle: opened declines, a later event approves", async () => {
    // Spec's "Late toggle is fail-safe" scenario: a bot that enables auto-merge
    // shortly after opening is declined on the opened pass and caught on a later
    // event. The gate never wrongly approves; the worst case is a delayed
    // approval.
    vi.useFakeTimers();
    try {
      // First leg — opened, the stale world: Renovate has not toggled yet, so
      // the live GET (only after the grace) reports no auto-merge.
      const openedH = harness([pageOf(1)]);

      const opened = run(openedH, "bot", { action: "opened" });
      await vi.advanceTimersByTimeAsync(0);
      expect(openedH.get).not.toHaveBeenCalled(); // not before the grace

      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(openedH.get).toHaveBeenCalledOnce();
      await expect(opened).resolves.toBe(false);
      expect(openedH.createReview).not.toHaveBeenCalled();
      // The decline is the full pass's gate, not the preliminary pass.
      expect(openedH.log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining("nobody has enabled auto-merge"),
        }),
        "Not auto-approving",
      );

      // Second leg — a later event, with the bot now having toggled auto-merge
      // itself. Fetched without delay and approved.
      const laterH = harness([pageOf(1)], { autoMerge: enabledBySelf });

      const later = run(laterH, "bot", { action: "synchronize" });
      await vi.advanceTimersByTimeAsync(0);
      expect(laterH.get).toHaveBeenCalledOnce(); // no delay
      await expect(later).resolves.toBe(true);
      expect(laterH.createReview).toHaveBeenCalledOnce();
      expect(laterH.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ body: BOT_BODY, commit_id: "abc123" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("serve — submission guards", () => {
  it("does not submit when already approved at this commit", async () => {
    const h = harness([pageOf(1)], {
      autoMerge: enabledBySelf,
      reviews: [{ state: "APPROVED", user: { login: "woodhouse[bot]" }, commit_id: "abc123" }],
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("logs in dry-run without submitting a review", async () => {
    const h = harness([pageOf(1)], { autoMerge: enabledBySelf });

    const approved = await run(h, "bot", {}, true);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(
      expect.stringContaining("DRY_RUN: would approve pull request"),
    );
  });
});
