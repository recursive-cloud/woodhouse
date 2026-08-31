import { describe, expect, it } from "vitest";
import { decide, pathMatches, type ApprovalRequest } from "../src/approval/policy.js";
import { autoApprovalSchema, type AutoApprovalConfig } from "../src/config/schema.js";

const cfg = (o: Record<string, unknown> = {}): AutoApprovalConfig =>
  autoApprovalSchema.parse(o);

const request = (o: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  author: "renovate[bot]",
  draft: false,
  state: "open",
  changedFiles: ["package.json"],
  fileListTruncated: false,
  alreadyApproved: false,
  ...o,
});

const trusted = cfg({ allowedActors: ["renovate[bot]", "my-user"] });

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

describe("decide", () => {
  it("approves a trusted author", () => {
    expect(decide(request(), trusted)).toEqual({ approve: true });
  });

  it("matches actors case-insensitively", () => {
    expect(decide(request({ author: "My-User" }), trusted).approve).toBe(true);
  });

  it("refuses an untrusted author", () => {
    const result = decide(request({ author: "stranger" }), trusted);
    expect(result).toMatchObject({ approve: false });
    expect(result.approve === false && result.reason).toContain("allowedActors");
  });

  it("refuses everything when disabled", () => {
    expect(decide(request(), cfg({ enabled: false, allowedActors: ["renovate[bot]"] })).approve).toBe(false);
  });

  it("refuses when allowedActors is empty", () => {
    expect(decide(request(), cfg()).approve).toBe(false);
  });

  it("refuses a draft", () => {
    expect(decide(request({ draft: true }), trusted).approve).toBe(false);
  });

  it("refuses a closed pull request", () => {
    expect(decide(request({ state: "closed" }), trusted).approve).toBe(false);
  });

  it("does not approve twice at the same commit", () => {
    expect(decide(request({ alreadyApproved: true }), trusted).approve).toBe(false);
  });
});

describe("decide — privilege escalation guards", () => {
  it("refuses a PR that edits the config file", () => {
    // Otherwise a trusted actor could self-approve a change that widens
    // allowedActors, converting one entry into permanent control.
    const result = decide(
      request({ changedFiles: [".github/woodhouse.yml"] }),
      trusted,
    );
    expect(result).toMatchObject({ approve: false });
    expect(result.approve === false && result.reason).toContain("protected path");
  });

  it("refuses when only one file of many is protected", () => {
    expect(
      decide(
        request({ changedFiles: ["README.md", ".github/woodhouse.yaml"] }),
        trusted,
      ).approve,
    ).toBe(false);
  });

  it("refuses when the file list was truncated", () => {
    // A huge PR is where a protected-path change is easiest to hide.
    expect(
      decide(request({ fileListTruncated: true }), trusted).approve,
    ).toBe(false);
  });

  it("honours custom protectedPaths", () => {
    const config = cfg({
      allowedActors: ["renovate[bot]"],
      protectedPaths: [".github/workflows/"],
    });
    expect(
      decide(request({ changedFiles: [".github/workflows/ci.yml"] }), config)
        .approve,
    ).toBe(false);
  });

  it("protects config files by default with no config at all", () => {
    const config = cfg({ allowedActors: ["renovate[bot]"] });
    expect(
      decide(request({ changedFiles: [".github/woodhouse.yml"] }), config)
        .approve,
    ).toBe(false);
  });
});
