import { describe, expect, it } from "vitest";
import { evaluate, type CheckRunLike } from "../src/gatekeeper/evaluate.js";
import { gatekeeperSchema, type GatekeeperConfig } from "../src/config/schema.js";
import { WHITE_GLOVE_CHECK_NAME } from "../src/gatekeeper/constants.js";

const cfg = (over: Partial<GatekeeperConfig> = {}): GatekeeperConfig =>
  gatekeeperSchema.parse({ ...over });

const done = (name: string, conclusion: string | null): CheckRunLike => ({
  name,
  status: "completed",
  conclusion,
});

const running = (name: string, status = "in_progress"): CheckRunLike => ({
  name,
  status,
  conclusion: null,
});

describe("evaluate — basic outcomes", () => {
  it("passes when every check succeeded", () => {
    const result = evaluate([done("build", "success"), done("test", "success")], cfg());
    expect(result.outcome).toBe("success");
    expect(result.counts.passed).toBe(2);
  });

  it("fails on a failure", () => {
    expect(evaluate([done("build", "failure")], cfg()).outcome).toBe("failure");
  });

  it.each(["failure", "timed_out", "cancelled", "action_required", "stale"])(
    "treats %s as failure",
    (conclusion) => {
      expect(evaluate([done("build", conclusion)], cfg()).outcome).toBe("failure");
    },
  );

  it("is pending while any check is unfinished", () => {
    const result = evaluate([done("build", "success"), running("test")], cfg());
    expect(result.outcome).toBe("pending");
  });

  it.each(["queued", "in_progress", "waiting", "requested", "pending"])(
    "treats status %s as pending",
    (status) => {
      expect(evaluate([running("x", status)], cfg()).outcome).toBe("pending");
    },
  );
});

describe("evaluate — precedence", () => {
  it("lets failure win over pending", () => {
    // A failure is terminal; there is no point holding the PR at pending
    // waiting for checks that cannot change the answer.
    const result = evaluate([running("slow"), done("build", "failure")], cfg());
    expect(result.outcome).toBe("failure");
  });

  it("lets pending win over success", () => {
    expect(evaluate([done("a", "success"), running("b")], cfg()).outcome).toBe("pending");
  });

  it("reports every failing check, not just the first", () => {
    const result = evaluate(
      [done("a", "failure"), done("b", "timed_out"), done("c", "success")],
      cfg(),
    );
    expect(result.counts.failed).toBe(2);
    expect(result.summary).toContain("**a**");
    expect(result.summary).toContain("**b**");
  });
});

describe("evaluate — skipped and neutral", () => {
  it.each(["skipped", "neutral"])("ignores %s by default", (conclusion) => {
    const result = evaluate([done("optional", conclusion), done("build", "success")], cfg());
    expect(result.outcome).toBe("success");
    expect(result.counts.ignored).toBe(1);
  });

  it.each(["skipped", "neutral"])("fails on %s when the check is strict", (conclusion) => {
    const result = evaluate([done("build", conclusion)], cfg({ strictChecks: ["build"] }));
    expect(result.outcome).toBe("failure");
    expect(result.summary).toContain("strictChecks");
  });
});

describe("evaluate — strictChecks presence", () => {
  it("holds at pending when a strict check never reported", () => {
    // The failure mode this guards against: a workflow that did not trigger at
    // all reads as "nothing wrong" to a naive implementation.
    const result = evaluate([done("build", "success")], cfg({ strictChecks: ["security-scan"] }));
    expect(result.outcome).toBe("pending");
    expect(result.counts.missing).toBe(1);
    expect(result.summary).toContain("security-scan");
  });

  it("passes once the strict check reports success", () => {
    const result = evaluate(
      [done("build", "success"), done("security-scan", "success")],
      cfg({ strictChecks: ["security-scan"] }),
    );
    expect(result.outcome).toBe("success");
  });

  it("matches strict check names case-insensitively", () => {
    const result = evaluate(
      [done("Security-Scan", "success")],
      cfg({ strictChecks: ["security-scan"] }),
    );
    expect(result.outcome).toBe("success");
  });
});

describe("evaluate — ignoredChecks", () => {
  it("excludes ignored checks even when they fail", () => {
    const result = evaluate(
      [done("coverage", "failure"), done("build", "success")],
      cfg({ ignoredChecks: ["coverage"] }),
    );
    expect(result.outcome).toBe("success");
  });

  it("excludes ignored checks that are still running", () => {
    const result = evaluate(
      [running("preview-deploy"), done("build", "success")],
      cfg({ ignoredChecks: ["preview-deploy"] }),
    );
    expect(result.outcome).toBe("success");
  });

  it("gives strict precedence over ignored when both list a check", () => {
    // Contradictory config: resolve it in the safe direction rather than
    // silently honouring whichever list is checked first.
    const result = evaluate(
      [done("build", "failure")],
      cfg({ strictChecks: ["build"], ignoredChecks: ["build"] }),
    );
    expect(result.outcome).toBe("failure");
  });
});

describe("evaluate — self-reference", () => {
  it("never evaluates its own check run", () => {
    // Without this the check reacts to its own completion and loops forever.
    const result = evaluate(
      [done(WHITE_GLOVE_CHECK_NAME, "failure"), done("build", "success")],
      cfg(),
    );
    expect(result.outcome).toBe("success");
    expect(result.checks.map((c) => c.name)).not.toContain(WHITE_GLOVE_CHECK_NAME);
  });
});

describe("evaluate — defensive cases", () => {
  it("fails closed on an unrecognised conclusion", () => {
    // GitHub may add conclusion values; assuming an unknown one is benign is
    // the wrong default for something that gates merges.
    const result = evaluate([done("build", "quantum_superposition")], cfg());
    expect(result.outcome).toBe("failure");
    expect(result.summary).toContain("unrecognised");
  });

  it("treats completed-without-conclusion as pending", () => {
    expect(evaluate([done("build", null)], cfg()).outcome).toBe("pending");
  });

  it("returns success with no checks to evaluate", () => {
    // Reachable only when every check on the commit is explicitly ignored.
    // Chosen over pending so that configuration cannot deadlock a PR forever.
    const result = evaluate([], cfg());
    expect(result.outcome).toBe("success");
    expect(result.title).toBe("Nothing to check");
  });

  it("still blocks on missing strict checks when nothing else ran", () => {
    expect(evaluate([], cfg({ strictChecks: ["build"] })).outcome).toBe("pending");
  });

  it("does not let duplicate names mask a failure", () => {
    // Two apps may publish the same check name; failure must still win.
    const result = evaluate([done("build", "success"), done("build", "failure")], cfg());
    expect(result.outcome).toBe("failure");
  });
});

describe("evaluate — output", () => {
  it("puts actionable items first in the summary", () => {
    const result = evaluate([done("z-pass", "success"), done("a-fail", "failure")], cfg());
    expect(result.summary.indexOf("a-fail")).toBeLessThan(result.summary.indexOf("z-pass"));
  });

  it("pluralises titles correctly", () => {
    expect(evaluate([done("a", "failure")], cfg()).title).toBe("1 check failing");
    expect(evaluate([done("a", "failure"), done("b", "failure")], cfg()).title).toBe(
      "2 checks failing",
    );
  });
});

describe("evaluate — grace period for checks that have not started", () => {
  it("holds pending on an empty commit while emptyIsPending is set", () => {
    // The bug this fixes: when a PR opens, GitHub has usually not created the
    // Actions check runs yet. Concluding success there put a green required
    // check on a commit nothing had tested.
    const result = evaluate([], cfg(), { emptyIsPending: true });
    expect(result.outcome).toBe("pending");
    expect(result.title).toBe("Waiting for checks to start");
    expect(result.awaitingStart).toBe(true);
  });

  it("concludes success on an empty commit once the grace period is over", () => {
    // Otherwise a docs-only repository with no CI would block forever.
    const result = evaluate([], cfg(), { emptyIsPending: false });
    expect(result.outcome).toBe("success");
    expect(result.awaitingStart).toBe(true);
  });

  it("defaults to concluding, preserving behaviour for check_run events", () => {
    expect(evaluate([], cfg()).outcome).toBe("success");
  });

  it("treats a commit carrying only our own check as not started", () => {
    const result = evaluate([done(WHITE_GLOVE_CHECK_NAME, "success")], cfg(), {
      emptyIsPending: true,
    });
    expect(result.awaitingStart).toBe(true);
    expect(result.outcome).toBe("pending");
  });

  it("is not awaiting start once any other check exists", () => {
    const result = evaluate([running("build")], cfg(), {
      emptyIsPending: true,
    });
    expect(result.awaitingStart).toBe(false);
    expect(result.outcome).toBe("pending");
  });

  it("does not hold pending when checks ran but were all ignored", () => {
    // CI demonstrably ran, so there is nothing to wait for.
    const result = evaluate([done("coverage", "failure")], cfg({ ignoredChecks: ["coverage"] }), {
      emptyIsPending: true,
    });
    expect(result.awaitingStart).toBe(false);
    expect(result.outcome).toBe("success");
  });

  it("still fails an empty commit that is missing a strict check", () => {
    const result = evaluate([], cfg({ strictChecks: ["build"] }), {
      emptyIsPending: false,
    });
    expect(result.outcome).toBe("pending");
  });
});
