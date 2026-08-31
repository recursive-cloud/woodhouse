/**
 * Deep merge used to cascade the organisation baseline into a repository's
 * local configuration.
 */

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Keys that must never be walked, to avoid prototype pollution via YAML. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Merge `override` onto `base`.
 *
 * Objects merge recursively. Arrays are **replaced wholesale, not
 * concatenated**. Concatenation would make it impossible for a repository to
 * remove an entry it inherited — you could add to `autoApproval.allowedActors`
 * but never shrink it, which is unacceptable for a security-relevant list. An
 * explicit empty array is therefore a meaningful "none".
 *
 * An explicit `null` in the override also clears the inherited value, giving a
 * way to unset a baseline key.
 */
export function deepMerge<T>(base: unknown, override: unknown): T {
  if (override === undefined) return base as T;
  if (override === null) return undefined as T;

  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override as T;
  }

  const result: Plain = { ...base };

  for (const key of Object.keys(override)) {
    if (FORBIDDEN_KEYS.has(key)) continue;

    const merged = deepMerge(result[key], override[key]);
    if (merged === undefined) {
      delete result[key];
    } else {
      result[key] = merged;
    }
  }

  return result as T;
}

/** Merge an ordered list of layers, lowest precedence first. */
export function mergeLayers<T>(layers: readonly unknown[]): T {
  return layers.reduce<unknown>(
    (acc, layer) => deepMerge(acc, layer),
    {},
  ) as T;
}
