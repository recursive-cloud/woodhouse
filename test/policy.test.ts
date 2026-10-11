import { describe, expect, it } from "vitest";
import {
  classifyActor,
  decide,
  pathMatches,
  type ApprovalRequest,
} from "../src/approval/policy.js";
import { autoApprovalSchema, type AutoApprovalConfig } from "../src/config/schema.js";

const cfg = (o: Record<string, unknown> = {}): AutoApprovalConfig => autoApprovalSchema.parse(o);

const request = (o: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  author: "renovate[bot]",
  draft: false,
  state: "open",
  changedFiles: ["package.json"],
  fileListTruncated: false,
  alreadyApproved: false,
  ...o,
});

const trusted = cfg({ allowedActors: { owners: ["my-user"], bots: ["renovate[bot]"] } });

describe("pathMatches", () => {
  it("matches exactly", () => {
    expect(pathMatches(".github/woodhouse.yml", ".github/woodhouse.yml")).toBe(true);
    expect(pathMatches(".github/other.yml", ".github/woodhouse.yml")).toBe(false);
  });

  it("matches a directory prefix", () => {
    expect(pathMatches(".github/workflows/ci.yml", ".github/workflows/")).toBe(true);
    expect(pathMatches("src/index.ts", ".github/workflows/")).toBe(false);
  });

  it("matches a trailing wildcard", () => {
    expect(pathMatches("deploy/prod.tf", "deploy/*")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(pathMatches(".github/Woodhouse.yml", ".github/woodhouse.yml")).toBe(true);
  });

  it("does not match a prefix without a wildcard", () => {
    // "src" must not match "src-generated/..."
    expect(pathMatches("src-generated/a.ts", "src")).toBe(false);
  });
});

describe("classifyActor", () => {
  it("classifies owners, bots and everyone else", () => {
    expect(classifyActor("my-user", trusted)).toBe("owner");
    expect(classifyActor("renovate[bot]", trusted)).toBe("bot");
    expect(classifyActor("stranger", trusted)).toBe("neither");
  });

  it("matches membership case-insensitively", () => {
    expect(classifyActor("MY-USER", trusted)).toBe("owner");
    expect(classifyActor("Renovate[Bot]", trusted)).toBe("bot");
  });

  it("treats an author listed as both as an owner", () => {
    const both = cfg({ allowedActors: { owners: ["shared"], bots: ["shared"] } });
    expect(classifyActor("shared", both)).toBe("owner");
  });
});

describe("decide — actor-class × auto-merge matrix", () => {
  // Author class down the rows, `autoMergeEnabledBy` across the columns. The
  // `undefined` column is the preliminary pass, where the bot gate is inert.
  const cases: Array<{
    name: string;
    author: string;
    autoMergeEnabledBy?: string | null;
    approve: boolean;
    reason?: string;
  }> = [
    // Owners: approved regardless of the auto-merge state.
    {
      name: "owner, fact ungathered",
      author: "my-user",
      autoMergeEnabledBy: undefined,
      approve: true,
    },
    {
      name: "owner, nobody enabled auto-merge",
      author: "my-user",
      autoMergeEnabledBy: null,
      approve: true,
    },
    {
      name: "owner, another login enabled auto-merge",
      author: "my-user",
      autoMergeEnabledBy: "someone",
      approve: true,
    },
    {
      name: "owner, enabled auto-merge itself",
      author: "my-user",
      autoMergeEnabledBy: "my-user",
      approve: true,
    },
    // Bots: the gate applies only once the fact is gathered.
    {
      name: "bot, fact ungathered",
      author: "renovate[bot]",
      autoMergeEnabledBy: undefined,
      approve: true,
    },
    {
      name: "bot, nobody enabled auto-merge",
      author: "renovate[bot]",
      autoMergeEnabledBy: null,
      approve: false,
      reason: "nobody has enabled auto-merge",
    },
    {
      name: "bot, another login enabled auto-merge",
      author: "renovate[bot]",
      autoMergeEnabledBy: "my-user",
      approve: false,
      reason: "rather than the author",
    },
    {
      name: "bot, enabled auto-merge itself",
      author: "renovate[bot]",
      autoMergeEnabledBy: "renovate[bot]",
      approve: true,
    },
    // Neither list: refused on every pass, fact or no fact.
    {
      name: "neither list, fact ungathered",
      author: "stranger",
      autoMergeEnabledBy: undefined,
      approve: false,
      reason: "allowedActors",
    },
    {
      name: "neither list, self-enabled auto-merge",
      author: "stranger",
      autoMergeEnabledBy: "stranger",
      approve: false,
      reason: "allowedActors",
    },
  ];

  it.each(cases)("$name", ({ author, autoMergeEnabledBy, approve, reason }) => {
    const result = decide(request({ author, autoMergeEnabledBy }), trusted);
    expect(result.approve).toBe(approve);
    if (!approve && reason !== undefined) {
      expect(result.approve === false && result.reason).toContain(reason);
    }
  });

  it("matches the owner and bot lists case-insensitively", () => {
    expect(decide(request({ author: "MY-USER" }), trusted).approve).toBe(true);
    expect(
      decide(request({ author: "Renovate[Bot]", autoMergeEnabledBy: "RENOVATE[BOT]" }), trusted)
        .approve,
    ).toBe(true);
  });

  it("compares the auto-merge login case-insensitively", () => {
    // Same login, different casing — still the bot's own auto-merge.
    expect(
      decide(request({ author: "renovate[bot]", autoMergeEnabledBy: "Renovate[Bot]" }), trusted)
        .approve,
    ).toBe(true);
  });

  it("refuses when a different login enabled auto-merge, even in different casing", () => {
    const result = decide(
      request({ author: "renovate[bot]", autoMergeEnabledBy: "MY-USER" }),
      trusted,
    );
    expect(result.approve).toBe(false);
    expect(result.approve === false && result.reason).toContain("rather than the author");
  });

  it("treats an author in both lists as an owner", () => {
    // Owner membership means unconditional approval; the bot gate never applies.
    const both = cfg({ allowedActors: { owners: ["shared"], bots: ["shared"] } });
    expect(decide(request({ author: "shared", autoMergeEnabledBy: null }), both).approve).toBe(
      true,
    );
  });
});

describe("decide — shared guards", () => {
  // The guards apply to every class; exercise them with an owner author so the
  // bot gate is out of the picture.
  const owner = request({ author: "my-user" });

  it("refuses everything when disabled", () => {
    expect(
      decide(owner, cfg({ enabled: false, allowedActors: { owners: ["my-user"], bots: [] } }))
        .approve,
    ).toBe(false);
  });

  it("refuses when allowedActors is empty", () => {
    expect(decide(owner, cfg()).approve).toBe(false);
  });

  it("refuses a draft", () => {
    expect(decide(request({ author: "my-user", draft: true }), trusted).approve).toBe(false);
  });

  it("refuses a closed pull request", () => {
    expect(decide(request({ author: "my-user", state: "closed" }), trusted).approve).toBe(false);
  });

  it("does not approve twice at the same commit", () => {
    expect(decide(request({ author: "my-user", alreadyApproved: true }), trusted).approve).toBe(
      false,
    );
  });

  it("refuses when the file list was truncated", () => {
    // A huge PR is where a protected-path change is easiest to hide.
    expect(decide(request({ author: "my-user", fileListTruncated: true }), trusted).approve).toBe(
      false,
    );
  });
});

describe("decide — privilege escalation guards", () => {
  it("refuses a PR that edits the config file", () => {
    // Otherwise a trusted actor could self-approve a change that widens
    // allowedActors, converting one entry into permanent control.
    const result = decide(request({ changedFiles: [".github/woodhouse.yml"] }), trusted);
    expect(result).toMatchObject({ approve: false });
    expect(result.approve === false && result.reason).toContain("protected path");
  });

  it("refuses when only one file of many is protected", () => {
    expect(
      decide(request({ changedFiles: ["README.md", ".github/woodhouse.yaml"] }), trusted).approve,
    ).toBe(false);
  });

  it("honours custom protectedPaths", () => {
    const config = cfg({
      allowedActors: { owners: [], bots: ["renovate[bot]"] },
      protectedPaths: [".github/workflows/"],
    });
    expect(decide(request({ changedFiles: [".github/workflows/ci.yml"] }), config).approve).toBe(
      false,
    );
  });

  it("protects config files by default with no config at all", () => {
    const config = cfg({ allowedActors: { owners: [], bots: ["renovate[bot]"] } });
    expect(decide(request({ changedFiles: [".github/woodhouse.yml"] }), config).approve).toBe(
      false,
    );
  });

  it("vetoes protected paths for owners too", () => {
    expect(
      decide(request({ author: "my-user", changedFiles: [".github/woodhouse.yml"] }), trusted)
        .approve,
    ).toBe(false);
  });

  it("vetoes protected paths for bots that enabled auto-merge themselves", () => {
    // The gate adds a condition; it never replaces the protected-path veto.
    const result = decide(
      request({
        author: "renovate[bot]",
        autoMergeEnabledBy: "renovate[bot]",
        changedFiles: [".github/woodhouse.yml"],
      }),
      trusted,
    );
    expect(result.approve).toBe(false);
    expect(result.approve === false && result.reason).toContain("protected path");
  });

  it("refuses a bot whose auto-merge gate fails even on an otherwise clean PR", () => {
    const result = decide(request({ author: "renovate[bot]", autoMergeEnabledBy: null }), trusted);
    expect(result.approve).toBe(false);
    expect(result.approve === false && result.reason).toContain("nobody has enabled auto-merge");
  });

  it("reports the bot gate before the truncation veto when both apply", () => {
    // Reason order matters to an operator: the gate is evaluated before the
    // shared guards, so a bot with both problems hears about the gate first.
    const result = decide(
      request({ author: "renovate[bot]", autoMergeEnabledBy: null, fileListTruncated: true }),
      trusted,
    );
    expect(result.approve).toBe(false);
    expect(result.approve === false && result.reason).toContain("nobody has enabled auto-merge");
  });
});
