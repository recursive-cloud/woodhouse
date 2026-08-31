/**
 * Pure planning for settings sync.
 *
 * Every "what should change" decision lives here as a plain function over
 * plain data, so it can be tested exhaustively. The appliers in `apply.ts` do
 * nothing but execute the resulting plan.
 *
 * The recurring theme is diff-before-write: a push to the default branch fires
 * this for every repository, and blindly PATCHing unchanged settings would
 * burn rate limit and fill the audit log with no-op events.
 */

import type {
  LabelConfig,
  RepositoryConfig,
  RulesetConfig,
} from "../config/schema.js";

export interface Change {
  readonly resource: string;
  readonly action: "create" | "update" | "delete" | "rename";
  readonly detail: string;
}

/* -------------------------------------------------------------------------
 * Repository settings
 * ---------------------------------------------------------------------- */

/** Fields we never send even if somehow present; belt and braces. */
const FORBIDDEN_REPO_FIELDS = new Set(["private", "archived", "topics"]);

/**
 * Return only the fields whose desired value differs from current.
 * Returns an empty object when the repository is already correct.
 */
export function diffRepositorySettings(
  current: Record<string, unknown>,
  desired: RepositoryConfig,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    // `topics` has its own endpoint and is handled separately.
    if (FORBIDDEN_REPO_FIELDS.has(key)) continue;
    if (current[key] === value) continue;
    patch[key] = value;
  }

  return patch;
}

/* -------------------------------------------------------------------------
 * Topics
 * ---------------------------------------------------------------------- */

/** Topics are a set; order and case are not significant to GitHub. */
export function topicsDiffer(
  current: readonly string[],
  desired: readonly string[],
): boolean {
  const norm = (list: readonly string[]) =>
    [...new Set(list.map((t) => t.toLowerCase()))].sort();

  const a = norm(current);
  const b = norm(desired);
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}

/* -------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------- */

export interface ExistingLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface LabelPlan {
  readonly create: LabelConfig[];
  readonly update: LabelConfig[];
  readonly rename: LabelConfig[];
  readonly delete: string[];
}

const normaliseColour = (colour: string | undefined): string | undefined =>
  colour?.replace(/^#/, "").toLowerCase();

export function planLabels(
  existing: readonly ExistingLabel[],
  desired: readonly LabelConfig[],
  prune: boolean,
): LabelPlan {
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l]));

  const plan: LabelPlan = { create: [], update: [], rename: [], delete: [] };
  const claimed = new Set<string>();

  for (const label of desired) {
    const target = byName.get(label.name.toLowerCase());

    // A rename is only meaningful if the source exists and the destination
    // does not; otherwise treat it as an ordinary create/update, which avoids
    // a 422 when the rename has already been applied on a previous run.
    if (label.from !== undefined) {
      const source = byName.get(label.from.toLowerCase());
      if (source !== undefined && target === undefined) {
        plan.rename.push(label);
        claimed.add(source.name.toLowerCase());
        claimed.add(label.name.toLowerCase());
        continue;
      }
    }

    if (target === undefined) {
      plan.create.push(label);
      claimed.add(label.name.toLowerCase());
      continue;
    }

    claimed.add(target.name.toLowerCase());

    const colourChanged =
      label.color !== undefined &&
      normaliseColour(label.color) !== normaliseColour(target.color);

    const descriptionChanged =
      label.description !== undefined &&
      label.description !== (target.description ?? "");

    // Casing-only differences still warrant an update; GitHub preserves case.
    const caseChanged = label.name !== target.name;

    if (colourChanged || descriptionChanged || caseChanged) {
      plan.update.push(label);
    }
  }

  if (prune) {
    for (const label of existing) {
      if (!claimed.has(label.name.toLowerCase())) plan.delete.push(label.name);
    }
  }

  return plan;
}

/* -------------------------------------------------------------------------
 * Rulesets
 * ---------------------------------------------------------------------- */

export interface ExistingRuleset {
  readonly id: number;
  readonly name: string;
}

export interface RulesetPlan {
  readonly create: RulesetConfig[];
  readonly update: { readonly id: number; readonly ruleset: RulesetConfig }[];
  readonly delete: { readonly id: number; readonly name: string }[];
}

/**
 * Rulesets are matched by name, which is the only stable user-facing
 * identifier; IDs are assigned by GitHub and are not knowable from config.
 */
export function planRulesets(
  existing: readonly ExistingRuleset[],
  desired: readonly RulesetConfig[],
  prune: boolean,
): RulesetPlan {
  const byName = new Map(existing.map((r) => [r.name.toLowerCase(), r]));
  const claimed = new Set<string>();

  const plan: RulesetPlan = { create: [], update: [], delete: [] };

  for (const ruleset of desired) {
    const key = ruleset.name.toLowerCase();
    const match = byName.get(key);
    claimed.add(key);

    if (match === undefined) {
      plan.create.push(ruleset);
    } else {
      // Rulesets are always rewritten rather than diffed: the stored shape
      // GitHub returns is heavily normalised (defaults filled in, actor IDs
      // resolved) and comparing it against the authored YAML produces
      // constant false positives. A PUT is idempotent, so this is safe.
      plan.update.push({ id: match.id, ruleset });
    }
  }

  if (prune) {
    for (const ruleset of existing) {
      if (!claimed.has(ruleset.name.toLowerCase())) {
        plan.delete.push({ id: ruleset.id, name: ruleset.name });
      }
    }
  }

  return plan;
}
