/**
 * Call-recording helpers shared by the feature fakes.
 *
 * A fake that asserts on its own calls appends a call name to a list and returns
 * it through `vi.fn`, so a scenario reads the same call log the corresponding
 * unit test does. `recorder` writes that log and `recorded` wraps one stubbed
 * method around it. This module is not a vitest entry: the fake modules import it.
 */

import { vi } from "vitest";

/** The call log a fake writes through. */
export type CallLog = (call: string) => void;

/** The call-log writer: `label:call` when a label is supplied, `call` otherwise. */
export function recorder(calls: string[], label?: string): CallLog {
  return (call) => {
    calls.push(label === undefined ? call : `${label}:${call}`);
  };
}

/**
 * A `vi.fn` that records its call name, then delegates to `impl`. The name may
 * be derived from the call's arguments, for route-shaped calls.
 */
export function recorded<Args extends unknown[], Result>(
  record: CallLog,
  name: string | ((...args: Args) => string),
  impl: (...args: Args) => Result,
) {
  return vi.fn((...args: Args) => {
    record(typeof name === "function" ? name(...args) : name);
    return impl(...args);
  });
}
