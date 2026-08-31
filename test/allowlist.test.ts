import { describe, expect, it } from "vitest";
import { Allowlist, resolveOwner } from "../src/security/allowlist.js";

describe("resolveOwner", () => {
  it("prefers repository.owner.login", () => {
    expect(
      resolveOwner({
        repository: { owner: { login: "octo" } },
        organization: { login: "other" },
      }),
    ).toEqual({ owner: "octo", source: "repository.owner.login" });
  });

  it("falls back to organization for events without a repository", () => {
    expect(resolveOwner({ organization: { login: "my-org" } })).toEqual({
      owner: "my-org",
      source: "organization.login",
    });
  });

  it("falls back to the installation account", () => {
    expect(
      resolveOwner({ installation: { account: { login: "acct" } } }),
    ).toEqual({ owner: "acct", source: "installation.account.login" });
  });

  it("never derives the owner from sender", () => {
    // sender is the actor, not the resource owner. Trusting it would let any
    // allowlisted user act on repositories they do not own.
    expect(resolveOwner({ sender: { login: "attacker" } }).owner).toBeUndefined();
  });

  it.each([null, undefined, 42, "string", {}, { repository: null }])(
    "returns undefined for malformed payload %p",
    (payload) => {
      expect(resolveOwner(payload).owner).toBeUndefined();
    },
  );

  it("ignores blank logins", () => {
    expect(resolveOwner({ repository: { owner: { login: "   " } } }).owner)
      .toBeUndefined();
  });
});

describe("Allowlist", () => {
  const list = new Allowlist(["My-User", "homelab-org"]);

  it("matches case-insensitively", () => {
    expect(list.has("my-user")).toBe(true);
    expect(list.has("MY-USER")).toBe(true);
  });

  it("rejects unknown owners", () => {
    expect(list.has("someone-else")).toBe(false);
  });

  it("does not match on substrings", () => {
    expect(list.has("my-user-evil")).toBe(false);
    expect(list.has("my-us")).toBe(false);
  });

  it("refuses to construct empty", () => {
    expect(() => new Allowlist([])).toThrow();
  });

  it("allows an allowlisted repository owner", () => {
    const decision = list.check({
      repository: { owner: { login: "homelab-org" } },
    });
    expect(decision).toEqual({ allowed: true, owner: "homelab-org" });
  });

  it("rejects a non-allowlisted owner with a reason", () => {
    const decision = list.check({ repository: { owner: { login: "evil" } } });
    expect(decision).toEqual({
      allowed: false,
      owner: "evil",
      reason: "not-allowlisted",
    });
  });

  it("fails closed when the owner cannot be determined", () => {
    expect(list.check({}).allowed).toBe(false);
    expect(list.check({})).toMatchObject({ reason: "unresolved-owner" });
  });
});
