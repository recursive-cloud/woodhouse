/**
 * Probot and delivery-context fakes for the settings-sync suites.
 *
 * The real `createApp` wiring registers dozens of listeners, so the fake Probot
 * maps each event to a list of callbacks; the context factories carry the
 * payload shapes the guarded handlers read. This module is not a vitest entry.
 */

import type { Probot } from "probot";
import type { RecordingOctokit } from "./octokit-fakes.js";
import { fakeLogger } from "../support/scenario.js";

/**
 * Multi-handler Probot stand-in: `createApp` registers dozens of listeners, so
 * events map to a list of callbacks rather than a single one.
 */
export function fakeProbot() {
  const handlers = new Map<string, ((ctx: unknown) => Promise<void>)[]>();

  const app = {
    on: (events: string | string[], cb: (ctx: unknown) => Promise<void>) => {
      const list = Array.isArray(events) ? events : [events];
      for (const event of list) {
        const existing = handlers.get(event) ?? [];
        existing.push(cb);
        handlers.set(event, existing);
      }
    },
  } as unknown as Probot;

  return {
    app,
    async deliver(event: string, context: unknown): Promise<void> {
      const list = handlers.get(event);
      if (list === undefined) throw new Error(`no handler registered for ${event}`);
      await Promise.all(list.map((cb) => cb(context)));
    },
  };
}

const OWNER = { login: "trusted-org" };

export interface PushContextOptions {
  readonly ref?: string;
  readonly changed?: string[];
  readonly deleted?: boolean;
}

/** A `push` delivery context for the fake Probot. */
export function pushContext(octokit: RecordingOctokit, options?: PushContextOptions) {
  const {
    ref = "refs/heads/main",
    changed = [".github/woodhouse.yml"],
    deleted = false,
  } = options ?? {};
  return {
    name: "push",
    id: "delivery-push",
    log: fakeLogger(),
    octokit,
    payload: {
      ref,
      deleted,
      repository: { default_branch: "main", name: "widgets", owner: OWNER },
      commits: [{ added: changed, modified: [], removed: [] }],
    },
  };
}

/** A `pull_request.closed` (merged) delivery context for the fake Probot. */
export function closedContext(octokit: RecordingOctokit) {
  return {
    name: "pull_request",
    id: "delivery-closed",
    log: fakeLogger(),
    octokit,
    payload: {
      action: "closed",
      pull_request: { number: 7, merged: true, base: { ref: "main" } },
      repository: { default_branch: "main", name: "widgets", owner: OWNER },
    },
  };
}
