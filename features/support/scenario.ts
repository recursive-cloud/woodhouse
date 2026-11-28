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

export interface PaginatePagesOptions {
  /** Page size when the caller did not set `per_page`; defaults to 100. */
  readonly defaultPerPage?: number;
  /** Pull the page rows out of the response's `data`; defaults to `data` as an array. */
  readonly unwrap?: (data: unknown) => unknown[];
}

/**
 * Mirrors octokit's pagination: call the route once per page until a short page.
 * `unwrap` selects the array inside an object response (e.g. `check_runs`). The
 * `per_page` fallback of 100 is the fakes' historical behaviour, not the REST
 * API default (30): these scenarios list well under 100 rows, so one page is
 * always short and the loop stops after a single call.
 */
export async function paginatePages(
  route: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
  params: Record<string, unknown>,
  options: PaginatePagesOptions,
): Promise<unknown[]> {
  const perPage =
    typeof params.per_page === "number" ? params.per_page : (options.defaultPerPage ?? 100);
  const unwrap = options.unwrap ?? ((data: unknown) => (Array.isArray(data) ? data : []));
  const rows: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await route({ ...params, page });
    const batch = unwrap(data);
    rows.push(...batch);
    if (batch.length < perPage) break;
  }
  return rows;
}

/** The fakes' array-response pagination, kept for the suites that only list arrays. */
export function paginateFake() {
  return vi.fn(
    (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
    ) => paginatePages(route, params, {}),
  );
}

/** The scenario-level hook functions `describeFeature` hands a steps file. */
export interface ScenarioClockHooks {
  readonly BeforeEachScenario: (callback: () => void) => void;
  readonly AfterEachScenario: (callback: () => void) => void;
}

/**
 * Bracket every scenario with the fake clock. vitest-cucumber runs one test per
 * step, so a per-test hook would discard the clock between the step that
 * schedules work and the step that advances it; these hooks install it once
 * per scenario and restore real timers afterwards.
 */
export function installScenarioFakeClock(hooks: ScenarioClockHooks): void {
  hooks.BeforeEachScenario(() => {
    vi.useFakeTimers();
  });
  hooks.AfterEachScenario(() => {
    vi.useRealTimers();
  });
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
