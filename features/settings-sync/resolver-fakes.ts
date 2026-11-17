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

const LOCAL_SOURCE = "acme/widgets:.github/woodhouse.yml";

/** A `vi.fn` that records its name first, then runs `impl`. */
function recorded<Args extends unknown[], Result>(
  calls: string[],
  name: string,
  impl: (...args: Args) => Result,
) {
  return vi.fn((...args: Args) => {
    calls.push(name);
    return impl(...args);
  });
}

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
    invalidate: recorded(calls, "invalidate", noop),
    invalidateOwner: recorded(calls, "invalidateOwner", noop),
    resolve: recorded(calls, "resolve", async () => resolved),
  };

  return { resolver, calls, config, resolved };
}
