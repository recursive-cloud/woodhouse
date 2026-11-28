import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Probot } from "probot";
import { serve } from "../src/approval/silverPlatter.js";
import { createApp } from "../src/app.js";
import { Allowlist } from "../src/security/allowlist.js";
import { GuardedApp, guardedFor } from "../src/security/guard.js";
import { autoApprovalSchema, type AutoApprovalConfig } from "../src/config/schema.js";
import { resetAppLoginCache } from "../src/github/app-login.js";
import {
  OWNER,
  RENOVATE,
  SHA,
  enabledBySelf,
  harness,
  pageOf,
  pull,
} from "./silver-platter-harness.js";

const botConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { bots: [RENOVATE] },
});

const ownerConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { owners: [OWNER] },
});

const mixedConfig: AutoApprovalConfig = autoApprovalSchema.parse({
  allowedActors: { owners: [OWNER], bots: [RENOVATE] },
});

const SIGN_OFF = "_Woodhouse, at your service._";

const OWNER_BODY =
  "Very good, sir. Approving on your behalf — this pull request touches no protected paths.\n\n" +
  SIGN_OFF;

const BOT_BODY =
  "Sir, just letting you know I am letting the handyman in to fix a few things — " +
  "renovate[bot] asked to be merged and this pull request touches no protected paths.\n\n" +
  SIGN_OFF;

function run(
  h: ReturnType<typeof harness>,
  config: AutoApprovalConfig = botConfig,
  dryRun = false,
): Promise<boolean> {
  return serve({ octokit: h.octokit, log: h.log, dryRun }, "acme", "widgets", SHA, config);
}

beforeEach(() => {
  // appLogin is cached per process; each test owns a fresh fake octokit.
  resetAppLoginCache();
});

describe("serve — the commit-level pass", () => {
  it("approves an eligible untruncated pull request, pinned to the commit, with the bot body", async () => {
    const h = harness({ associated: [pull({ autoMerge: enabledBySelf })] });

    const approved = await run(h);

    expect(approved).toBe(true);
    expect(h.listAssociated).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        commit_sha: SHA,
        per_page: 100,
      }),
    );
    expect(h.createReview).toHaveBeenCalledOnce();
    expect(h.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        pull_number: 7,
        event: "APPROVE",
        commit_id: SHA,
        body: BOT_BODY,
      }),
    );
    expect(h.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", pull_number: 7 }),
    );
  });

  it("does not even list the commit's pull requests when auto-approval is disabled", async () => {
    const h = harness({});
    const disabled = autoApprovalSchema.parse({
      enabled: false,
      allowedActors: { bots: [RENOVATE] },
    });

    const approved = await run(h, disabled);

    expect(approved).toBe(false);
    expect(h.paginate).not.toHaveBeenCalled();
    expect(h.listAssociated).not.toHaveBeenCalled();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("does nothing when the commit heads no pull request", async () => {
    const h = harness({ associated: [] });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.listAssociated).toHaveBeenCalledOnce();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.listFiles).not.toHaveBeenCalled();
    expect(h.listReviews).not.toHaveBeenCalled();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("ignores a listed pull request that is no longer open", async () => {
    const h = harness({ associated: [pull({ state: "closed" })] });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("aborts a pull request whose head moved after the listing", async () => {
    const h = harness({
      associated: [pull({})],
      live: { 7: pull({ headSha: "def456" }) },
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.listFiles).not.toHaveBeenCalled();
    expect(h.listReviews).not.toHaveBeenCalled();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("aborts a pull request that closed after the listing", async () => {
    const h = harness({
      associated: [pull({})],
      live: { 7: pull({ state: "closed" }) },
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("evaluates two open pull requests independently and approves only the eligible one", async () => {
    const h = harness({
      associated: [
        pull({ number: 7, author: OWNER }),
        // A bot that never enabled auto-merge is refused on its own facts.
        pull({ number: 8, author: RENOVATE, autoMerge: null }),
      ],
    });

    const approved = await run(h, mixedConfig);

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledOnce();
    expect(h.createReview).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 7 }));
  });

  it("logs a rejected live GET and moves on instead of rejecting", async () => {
    const failure = new Error("boom");
    const h = harness({ getError: failure });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, pr: 7, sha: SHA }),
      expect.any(String),
    );
  });

  it("keeps going when one pull request fails, approving its eligible sibling", async () => {
    const failure = new Error("boom");
    const h = harness({
      associated: [
        pull({ number: 7, autoMerge: enabledBySelf }),
        pull({ number: 8, autoMerge: enabledBySelf }),
      ],
      // The first pull request's re-fetch rejects; the second is eligible.
      live: { 7: failure },
    });

    const approved = await run(h);

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledOnce();
    expect(h.createReview).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 8 }));
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, pr: 7, sha: SHA }),
      expect.any(String),
    );
  });

  it("propagates a rejected listing — a failure is not 'no pull requests'", async () => {
    const h = harness({ listError: new Error("listing down") });

    await expect(run(h)).rejects.toThrow("listing down");
    expect(h.get).not.toHaveBeenCalled();
    expect(h.createReview).not.toHaveBeenCalled();
  });
});

describe("serve — actor-class tailors the review body", () => {
  it("uses the owner body for an owner author", async () => {
    const h = harness({ associated: [pull({ author: OWNER })] });

    const approved = await run(h, ownerConfig);

    expect(approved).toBe(true);
    expect(h.createReview).toHaveBeenCalledWith(expect.objectContaining({ body: OWNER_BODY }));
  });

  it("names the author in the bot body", async () => {
    const h = harness({ associated: [pull({ autoMerge: enabledBySelf })] });

    await run(h);

    expect(h.createReview).toHaveBeenCalledWith(expect.objectContaining({ body: BOT_BODY }));
  });
});

describe("serve — the auto-merge fact", () => {
  it("reads the fact from the same re-fetched pull request, never a second GET", async () => {
    const h = harness({ associated: [pull({ autoMerge: enabledBySelf })] });

    const approved = await run(h);

    expect(approved).toBe(true);
    expect(h.get).toHaveBeenCalledOnce();
  });

  it("declines when nobody enabled auto-merge", async () => {
    // The preliminary pass must not decline the bot for the missing fact;
    // the full pass, with the gathered null, is what declines.
    const h = harness({ associated: [pull({ autoMerge: null })] });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.listFiles).toHaveBeenCalledOnce();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("declines when a different login enabled auto-merge", async () => {
    const h = harness({
      associated: [pull({ autoMerge: { enabled_by: { login: OWNER } } })],
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("approves an owner without depending on auto-merge", async () => {
    const h = harness({ associated: [pull({ author: OWNER, autoMerge: null })] });

    const approved = await run(h, ownerConfig);

    expect(approved).toBe(true);
    // One GET in total: the mandated re-fetch, not an auto-merge lookup.
    expect(h.get).toHaveBeenCalledOnce();
  });
});

describe("serve — submission guards", () => {
  it("refuses a draft before any further reads", async () => {
    const h = harness({ associated: [pull({ draft: true, autoMerge: enabledBySelf })] });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.listReviews).not.toHaveBeenCalled();
    expect(h.listFiles).not.toHaveBeenCalled();
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("refuses a pull request modifying a protected path", async () => {
    const h = harness({
      associated: [pull({ autoMerge: enabledBySelf })],
      filePages: [[{ filename: ".github/woodhouse.yml", status: "modified" }]],
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("refuses a listing truncated at the cap, with no review submitted", async () => {
    // The safety cap is 10 pages; 10 full pages means there may be more. The
    // bot's own auto-merge is present, so truncation is genuinely the reason.
    const h = harness({
      associated: [pull({ autoMerge: enabledBySelf })],
      filePages: Array.from({ length: 10 }, (_, page) => pageOf(100, page * 100)),
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.listFiles).toHaveBeenCalledTimes(10);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("does not submit when already approved at this commit", async () => {
    const h = harness({
      associated: [pull({ autoMerge: enabledBySelf })],
      reviews: [{ state: "APPROVED", user: { login: "woodhouse[bot]" }, commit_id: SHA }],
    });

    const approved = await run(h);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
  });

  it("logs in dry-run without submitting a review", async () => {
    const h = harness({ associated: [pull({ author: OWNER })] });

    const approved = await run(h, ownerConfig, true);

    expect(approved).toBe(false);
    expect(h.createReview).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(
      expect.stringContaining("DRY_RUN: would approve pull request"),
    );
  });
});

describe("serve — the app login cache", () => {
  it("resolves the app login once per process, and resetAppLoginCache clears it", async () => {
    const first = harness({ associated: [pull({ author: OWNER })] });
    await run(first, ownerConfig);
    expect(first.getAuthenticated).toHaveBeenCalledOnce();

    // A second octokit reuses the cached login: GET /app is not repeated.
    const second = harness({ associated: [pull({ author: OWNER })] });
    await run(second, ownerConfig);
    expect(second.getAuthenticated).not.toHaveBeenCalled();

    resetAppLoginCache();

    const third = harness({ associated: [pull({ author: OWNER })] });
    await run(third, ownerConfig);
    expect(third.getAuthenticated).toHaveBeenCalledOnce();
  });
});

describe("createApp — approval is no longer a pull_request listener", () => {
  it("registers no silver-platter listener and covers pull_request.ready_for_review", () => {
    const app = { on: vi.fn() } as unknown as Probot;
    const spy = vi.spyOn(GuardedApp.prototype, "on");

    try {
      createApp({
        allowlist: new Allowlist(["acme"]),
        baselineRepo: "baseline",
        dryRun: false,
      })(app);

      const names = spy.mock.calls.map((call) => call[1]);
      expect(names).not.toContain("silver-platter");
      expect(guardedFor(app)?.handlesEvent("pull_request", "ready_for_review")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
