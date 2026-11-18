/**
 * Shared scaffolding for the Gherkin acceptance suites.
 *
 * Every `.steps.ts` file reads its Examples cells and builds a logger the same
 * way, so both live here rather than being copied into each capability folder.
 * This module is not a vitest entry: it is imported by the step files only.
 */

import { vi } from "vitest";
import type { Logger } from "pino";

/** The Examples cells vitest-cucumber hands a scenario outline step. */
export type ScenarioVariables = Record<string, unknown>;

/** Read one Examples cell. A missing cell is a malformed scenario, not a value to guess. */
export function readCell(variables: ScenarioVariables, key: string): string {
  const value = variables[key];
  if (typeof value !== "string") {
    throw new Error(`Scenario outline row is missing a string "${key}" cell.`);
  }
  return value;
}

/**
 * The value an earlier step built, or a plain failure when a step ran out of
 * order. Steps hold their world in a mutable local, so every reader guards it.
 */
export function requireBuilt<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * Mirrors octokit's pagination: call the route once per page until a short page.
 * The `per_page` fallback of 100 is the fakes' historical behaviour, not the
 * REST API default (30): these scenarios list well under 100 rows, so one page
 * is always short and the loop stops after a single call.
 */
export function paginateFake() {
  return vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
    ) => {
      const perPage = (params.per_page as number | undefined) ?? 100;
      const out: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        out.push(...data);
        if (data.length < perPage) break;
      }
      return out;
    },
  );
}

type LogSpy = ReturnType<typeof vi.fn>;

/**
 * A logger whose every method is a spy; `child` returns the same logger.
 *
 * `log` points back at the logger, so a scenario can pass the object straight
 * to production code or destructure `{ log, warn }` to assert on the calls.
 */
export interface FakeLogger extends Logger {
  /** The pino-shaped logger handed to production code. */
  readonly log: Logger;
  readonly debug: LogSpy;
  readonly info: LogSpy;
  readonly warn: LogSpy;
  readonly error: LogSpy;
}

export function fakeLogger(): FakeLogger {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const log: Record<string, unknown> = { debug, info, warn, error };
  log.child = vi.fn(() => log);
  log.log = log;
  return log as unknown as FakeLogger;
}
