import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Allowlist } from "../src/security/allowlist.js";
import {
  closedContext,
  fakeProbot,
  makeAppOctokit,
  manualGate,
  OPEN_GATE,
  pushContext,
  settle,
} from "../features/settings-sync/fakes.js";

/**
 * App-level concurrency characterisation.
 *
 * The push and `pull_request.closed` deliveries both trigger a settings sync
 * for the same repository. Delivery order is not guaranteed and, in
 * production, the two can land within milliseconds of each other. This test
 * drives the real `createApp` wiring — real resolver, real mutex, real
 * handlers — through a multi-handler fake Probot.
 *
 * The sync's first applier read is held on a manual gate so the two deliveries
 * are forced to contend: whichever reaches the applier first must be the only
 * one that proceeds, because the shared mutex serialises the syncs. Recording
 * only the applier calls, tagged by delivery, makes the assertion independent
 * of yield granularity and of which delivery wins the race.
 */

/** The repository's own settings file, which is what opts it into a sync. */
const LOCAL_CONFIG = "settings:\n  enabled: true\nrepository:\n  has_issues: true\n";

const CONFIG_FILES = { "widgets:.github/woodhouse.yml": LOCAL_CONFIG };

describe("merge push and merged pull request race", () => {
  it("serializes the two same-repository syncs, in some order, never interleaved", async () => {
    const { app, deliver } = fakeProbot();
    const calls: string[] = [];
    const gate = manualGate();

    createApp({
      allowlist: new Allowlist(["trusted-org"]),
      baselineRepo: ".github-private",
      dryRun: false,
    })(app);

    const push = deliver(
      "push",
      pushContext(
        makeAppOctokit({ label: "push", calls, gate, configFiles: CONFIG_FILES }).octokit,
      ),
    );
    const closed = deliver(
      "pull_request.closed",
      closedContext(
        makeAppOctokit({ label: "closed", calls, gate, configFiles: CONFIG_FILES }).octokit,
      ),
    );

    // Fire both without awaiting (done above), then let both run as far as they
    // can. With the first applier read parked, a shared mutex permits exactly
    // one sync to have started: a single read, and no write yet. Without
    // serialisation the second sync reaches its read and writes while the first
    // is still held, so this length is the binding assertion.
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/:repos\.get$/);

    gate.release();
    await Promise.all([push, closed]);

    const pushBatch = ["push:repos.get", "push:repos.update"];
    const closedBatch = ["closed:repos.get", "closed:repos.update"];

    // Two contiguous batches. The spec says "in some order", so either
    // delivery may go first; what must never appear is an interleave.
    expect([
      [...pushBatch, ...closedBatch],
      [...closedBatch, ...pushBatch],
    ]).toContainEqual(calls);
  });
});

describe("push dispatch negative cases", () => {
  it("does not sync a repository with no local settings file", async () => {
    const { app, deliver } = fakeProbot();
    const calls: string[] = [];

    createApp({
      allowlist: new Allowlist(["trusted-org"]),
      baselineRepo: ".github-private",
      dryRun: false,
    })(app);

    // No local layer: the repository never opted in, so the implicit enabled
    // default must not start a sync.
    await deliver(
      "push",
      pushContext(makeAppOctokit({ label: "push", calls, gate: OPEN_GATE }).octokit, {
        ref: "refs/heads/main",
        changed: ["docs/woodhouse.yml"],
      }),
    );

    expect(calls).toEqual([]);
  });
});
