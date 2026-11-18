/**
 * Config-resolver fakes for the settings-sync suites.
 *
 * `resolvedConfig` builds the resolved shape an applier consumes; `fakeResolver`
 * stands in for the production cascade with a fully validated config, so the
 * appliers behave exactly as they would in production. This module is not a
 * vitest entry.
 */

import { vi } from "vitest";
import { woodhouseConfigSchema } from "../../src/config/schema.js";
import type { ResolvedConfig } from "../../src/config/resolver.js";
import type { MergeFeedbackResolver } from "../../src/settings/mergeFeedback.js";
import { recorder, recorded } from "../support/recorded.js";

const LOCAL_SOURCE = "acme/widgets:.github/woodhouse.yml";

const noop = () => undefined;

/** A resolution carrying a local layer unless overridden. */
export function resolvedConfig(
  configInput?: Record<string, unknown>,
  overrides?: Partial<ResolvedConfig>,
): ResolvedConfig {
  return {
    config: woodhouseConfigSchema.parse(configInput),
    sources: [LOCAL_SOURCE],
    issues: [],
    localSource: LOCAL_SOURCE,
    ...overrides,
  };
}

/**
 * Literal fake resolver. `resolve` returns a fully-validated config so the
 * appliers behave exactly as they would in production.
 */
export function fakeResolver(
  configInput?: Record<string, unknown>,
  overrides?: Partial<ResolvedConfig>,
) {
  const calls: string[] = [];
  const record = recorder(calls);
  const config = woodhouseConfigSchema.parse(configInput);

  const resolved: ResolvedConfig = {
    config,
    sources: [LOCAL_SOURCE],
    issues: [],
    localSource: LOCAL_SOURCE,
    ...overrides,
  };

  const resolver: MergeFeedbackResolver = {
    isBaselineRepo: vi.fn((_repo: string) => false),
    invalidate: recorded(record, "invalidate", noop),
    invalidateOwner: recorded(record, "invalidateOwner", noop),
    resolve: recorded(record, "resolve", async () => resolved),
  };

  return { resolver, calls, config, resolved };
}
