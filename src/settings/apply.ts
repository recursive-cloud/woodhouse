/**
 * Settings appliers.
 *
 * Executes the plans produced by `plan.ts`. Each applier is independent and
 * failures are collected rather than thrown immediately: one repository
 * lacking a `main` branch should not prevent its labels from being synced.
 */

import type { Context } from "probot";
import type { Logger } from "pino";
import type { WoodhouseConfig } from "../config/schema.js";
import {
  diffRepositorySettings,
  planLabels,
  planRulesets,
  topicsDiffer,
  type Change,
} from "./plan.js";

type Api = Context<"push">["octokit"];

export interface ApplyContext {
  readonly octokit: Api;
  readonly owner: string;
  readonly repo: string;
  readonly log: Logger;
  readonly dryRun: boolean;
}

export interface SyncResult {
  readonly changes: readonly Change[];
  readonly failures: readonly { resource: string; message: string }[];
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------
 * Repository core settings
 * ---------------------------------------------------------------------- */

async function applyRepository(
  ctx: ApplyContext,
  config: WoodhouseConfig,
): Promise<Change[]> {
  const { data: current } = await ctx.octokit.repos.get({
    owner: ctx.owner,
    repo: ctx.repo,
  });

  // Never fight the user over an archived repository: writes would fail, and
  // if they somehow succeeded that would be worse.
  if (current.archived) {
    ctx.log.info("Repository is archived; skipping settings sync");
    return [];
  }

  const changes: Change[] = [];

  const patch = diffRepositorySettings(
    current as unknown as Record<string, unknown>,
    config.repository,
  );

  if (Object.keys(patch).length > 0) {
    if (!ctx.dryRun) {
      await ctx.octokit.repos.update({
        owner: ctx.owner,
        repo: ctx.repo,
        ...patch,
      });
    }
    changes.push({
      resource: "repository",
      action: "update",
      detail: Object.keys(patch).sort().join(", "),
    });
  }

  const desiredTopics = config.repository.topics;
  if (
    desiredTopics !== undefined &&
    topicsDiffer(current.topics ?? [], desiredTopics)
  ) {
    if (!ctx.dryRun) {
      await ctx.octokit.repos.replaceAllTopics({
        owner: ctx.owner,
        repo: ctx.repo,
        // GitHub rejects uppercase topics outright.
        names: desiredTopics.map((t) => t.toLowerCase()),
      });
    }
    changes.push({
      resource: "topics",
      action: "update",
      detail: desiredTopics.join(", "),
    });
  }

  return changes;
}

/* -------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------- */

async function applyLabels(
  ctx: ApplyContext,
  config: WoodhouseConfig,
): Promise<Change[]> {
  if (config.labels.length === 0 && !config.settings.pruneLabels) return [];

  const existing = await ctx.octokit.paginate(
    ctx.octokit.issues.listLabelsForRepo,
    { owner: ctx.owner, repo: ctx.repo, per_page: 100 },
  );

  const plan = planLabels(
    existing.map((l) => ({
      name: l.name,
      color: l.color,
      description: l.description ?? null,
    })),
    config.labels,
    config.settings.pruneLabels,
  );

  const changes: Change[] = [];
  const base = { owner: ctx.owner, repo: ctx.repo };
  const colour = (c: string | undefined) => c?.replace(/^#/, "").toLowerCase();

  for (const label of plan.create) {
    if (!ctx.dryRun) {
      await ctx.octokit.issues.createLabel({
        ...base,
        name: label.name,
        ...(label.color !== undefined ? { color: colour(label.color)! } : {}),
        ...(label.description !== undefined
          ? { description: label.description }
          : {}),
      });
    }
    changes.push({ resource: "label", action: "create", detail: label.name });
  }

  for (const label of plan.rename) {
    if (!ctx.dryRun) {
      await ctx.octokit.issues.updateLabel({
        ...base,
        name: label.from!,
        new_name: label.name,
        ...(label.color !== undefined ? { color: colour(label.color)! } : {}),
        ...(label.description !== undefined
          ? { description: label.description }
          : {}),
      });
    }
    changes.push({
      resource: "label",
      action: "rename",
      detail: `${label.from} -> ${label.name}`,
    });
  }

  for (const label of plan.update) {
    if (!ctx.dryRun) {
      await ctx.octokit.issues.updateLabel({
        ...base,
        name: label.name,
        new_name: label.name,
        ...(label.color !== undefined ? { color: colour(label.color)! } : {}),
        ...(label.description !== undefined
          ? { description: label.description }
          : {}),
      });
    }
    changes.push({ resource: "label", action: "update", detail: label.name });
  }

  for (const name of plan.delete) {
    if (!ctx.dryRun) {
      await ctx.octokit.issues.deleteLabel({ ...base, name });
    }
    changes.push({ resource: "label", action: "delete", detail: name });
  }

  return changes;
}

/* -------------------------------------------------------------------------
 * Branch protection
 * ---------------------------------------------------------------------- */

async function applyBranchProtection(
  ctx: ApplyContext,
  config: WoodhouseConfig,
): Promise<Change[]> {
  const branches = Object.entries(config.branchProtection);
  if (branches.length === 0) return [];

  const changes: Change[] = [];

  for (const [branch, protection] of branches) {
    // Always PUT rather than diff: the GET representation of branch
    // protection is structurally quite different from the PUT payload
    // (nested `enabled` wrappers, expanded actor objects), and comparing them
    // reliably is more error-prone than an idempotent write.
    try {
      if (!ctx.dryRun) {
        await ctx.octokit.repos.updateBranchProtection({
          owner: ctx.owner,
          repo: ctx.repo,
          branch,
          // These three are required by the API and must be explicitly null
          // when unused, otherwise the request is rejected.
          required_status_checks:
            protection.required_status_checks === undefined
              ? null
              : protection.required_status_checks,
          enforce_admins: protection.enforce_admins ?? null,
          required_pull_request_reviews:
            protection.required_pull_request_reviews === undefined
              ? null
              : protection.required_pull_request_reviews,
          restrictions: null,
          ...(protection.required_linear_history !== undefined
            ? { required_linear_history: protection.required_linear_history }
            : {}),
          ...(protection.allow_force_pushes !== undefined
            ? { allow_force_pushes: protection.allow_force_pushes }
            : {}),
          ...(protection.allow_deletions !== undefined
            ? { allow_deletions: protection.allow_deletions }
            : {}),
          ...(protection.required_conversation_resolution !== undefined
            ? {
                required_conversation_resolution:
                  protection.required_conversation_resolution,
              }
            : {}),
          ...(protection.lock_branch !== undefined
            ? { lock_branch: protection.lock_branch }
            : {}),
          ...(protection.block_creations !== undefined
            ? { block_creations: protection.block_creations }
            : {}),
        });
      }
      changes.push({
        resource: "branch-protection",
        action: "update",
        detail: branch,
      });
    } catch (error) {
      if (statusOf(error) === 404) {
        // Configuring protection for a branch that does not exist is a normal
        // consequence of a shared baseline, not an error worth alerting on.
        ctx.log.debug({ branch }, "Branch does not exist; skipping protection");
        continue;
      }
      throw error;
    }
  }

  return changes;
}

/* -------------------------------------------------------------------------
 * Rulesets
 * ---------------------------------------------------------------------- */

async function applyRulesets(
  ctx: ApplyContext,
  config: WoodhouseConfig,
): Promise<Change[]> {
  if (config.rulesets.length === 0 && !config.settings.pruneRulesets) return [];

  const existing = await ctx.octokit.paginate(
    "GET /repos/{owner}/{repo}/rulesets",
    { owner: ctx.owner, repo: ctx.repo, per_page: 100 },
  );

  const plan = planRulesets(
    (existing as { id: number; name: string }[]).map((r) => ({
      id: r.id,
      name: r.name,
    })),
    config.rulesets,
    config.settings.pruneRulesets,
  );

  const changes: Change[] = [];

  for (const ruleset of plan.create) {
    if (!ctx.dryRun) {
      // `rules` is a large discriminated union in the generated types. Our
      // schema keeps it open on purpose (see rulesetSchema), so the cast is
      // required; GitHub validates the payload server-side either way.
      await ctx.octokit.request("POST /repos/{owner}/{repo}/rulesets", {
        owner: ctx.owner,
        repo: ctx.repo,
        ...ruleset,
      } as never);
    }
    changes.push({
      resource: "ruleset",
      action: "create",
      detail: ruleset.name,
    });
  }

  for (const { id, ruleset } of plan.update) {
    if (!ctx.dryRun) {
      await ctx.octokit.request(
        "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
        {
          owner: ctx.owner,
          repo: ctx.repo,
          ruleset_id: id,
          ...ruleset,
        } as never,
      );
    }
    changes.push({
      resource: "ruleset",
      action: "update",
      detail: ruleset.name,
    });
  }

  for (const { id, name } of plan.delete) {
    if (!ctx.dryRun) {
      await ctx.octokit.request(
        "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}",
        { owner: ctx.owner, repo: ctx.repo, ruleset_id: id },
      );
    }
    changes.push({ resource: "ruleset", action: "delete", detail: name });
  }

  return changes;
}

/* -------------------------------------------------------------------------
 * Orchestration
 * ---------------------------------------------------------------------- */

const APPLIERS: {
  name: string;
  run: (ctx: ApplyContext, config: WoodhouseConfig) => Promise<Change[]>;
}[] = [
  { name: "repository", run: applyRepository },
  { name: "labels", run: applyLabels },
  { name: "branch-protection", run: applyBranchProtection },
  // Rulesets last: they can restrict what the app itself is permitted to do,
  // so everything else should already be in place before they take effect.
  { name: "rulesets", run: applyRulesets },
];

export async function syncSettings(
  ctx: ApplyContext,
  config: WoodhouseConfig,
): Promise<SyncResult> {
  if (!config.settings.enabled) {
    ctx.log.debug("Settings sync not enabled for this repository");
    return { changes: [], failures: [] };
  }

  const changes: Change[] = [];
  const failures: { resource: string; message: string }[] = [];

  for (const applier of APPLIERS) {
    try {
      changes.push(...(await applier.run(ctx, config)));
    } catch (error) {
      const status = statusOf(error);
      const message = messageOf(error);

      if (status === 403) {
        // Almost always a missing permission on the App registration. Say so,
        // rather than emitting a bare 403 that looks like a transient fault.
        ctx.log.error(
          { applier: applier.name, status },
          `Forbidden applying ${applier.name}; the GitHub App is probably ` +
            "missing a permission (administration: write is required for " +
            "repository settings and branch protection)",
        );
      } else {
        ctx.log.error(
          { applier: applier.name, status, err: message },
          `Failed applying ${applier.name}`,
        );
      }
      failures.push({ resource: applier.name, message });
    }
  }

  if (changes.length > 0) {
    ctx.log.info(
      { changes, dryRun: ctx.dryRun },
      ctx.dryRun
        ? `DRY_RUN: would apply ${changes.length} change(s)`
        : `Applied ${changes.length} change(s)`,
    );
  } else if (failures.length === 0) {
    ctx.log.debug("Repository already matches configuration");
  }

  return { changes, failures };
}
