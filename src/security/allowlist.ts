/**
 * Installation lockdown: the hard security boundary.
 *
 * Every webhook delivery passes through here before any handler runs. The
 * design goal is fail-closed: if we cannot confidently determine which owner an
 * event belongs to, we reject it.
 */

export type OwnerSource =
  | "repository.owner.login"
  | "organization.login"
  | "installation.account.login"
  | "sender.login";

export interface OwnerResolution {
  readonly owner: string | undefined;
  readonly source: OwnerSource | undefined;
}

interface MaybePayload {
  repository?: { owner?: { login?: unknown } | null } | null;
  organization?: { login?: unknown } | null;
  installation?: { account?: { login?: unknown } | null } | null;
  sender?: { login?: unknown } | null;
}

function asLogin(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Resolve the owner of an event.
 *
 * `repository.owner.login` is the primary source as specified, but a number of
 * events we care about (`installation`, `installation_repositories`,
 * org-level events) carry no `repository` object at all. Falling back through
 * these keeps the guard usable across the whole event surface.
 *
 * `sender.login` is deliberately NOT used as a fallback for authorization: the
 * sender is the actor who triggered the event, not the owner of the resource,
 * and treating it as the owner would let any allowlisted user act on any repo
 * anywhere. It is resolved only so it can be logged on rejection.
 */
export function resolveOwner(payload: unknown): OwnerResolution {
  if (typeof payload !== "object" || payload === null) {
    return { owner: undefined, source: undefined };
  }

  const p = payload as MaybePayload;

  const repoOwner = asLogin(p.repository?.owner?.login);
  if (repoOwner !== undefined) {
    return { owner: repoOwner, source: "repository.owner.login" };
  }

  const orgLogin = asLogin(p.organization?.login);
  if (orgLogin !== undefined) {
    return { owner: orgLogin, source: "organization.login" };
  }

  const accountLogin = asLogin(p.installation?.account?.login);
  if (accountLogin !== undefined) {
    return { owner: accountLogin, source: "installation.account.login" };
  }

  return { owner: undefined, source: undefined };
}

export type AllowlistDecision =
  | { readonly allowed: true; readonly owner: string }
  | {
      readonly allowed: false;
      readonly owner: string | undefined;
      readonly reason: "unresolved-owner" | "not-allowlisted";
    };

export class Allowlist {
  /** Logins stored lowercased; GitHub logins are case-insensitive. */
  private readonly targets: ReadonlySet<string>;

  constructor(targets: readonly string[]) {
    if (targets.length === 0) {
      throw new Error("Allowlist requires at least one target.");
    }
    this.targets = new Set(targets.map((t) => t.trim().toLowerCase()));
  }

  get size(): number {
    return this.targets.size;
  }

  has(owner: string): boolean {
    return this.targets.has(owner.trim().toLowerCase());
  }

  /** Describe the allowlist for startup logging. Safe to emit; not a secret. */
  describe(): string[] {
    return [...this.targets].sort();
  }

  check(payload: unknown): AllowlistDecision {
    const { owner } = resolveOwner(payload);

    if (owner === undefined) {
      return { allowed: false, owner: undefined, reason: "unresolved-owner" };
    }
    if (!this.has(owner)) {
      return { allowed: false, owner, reason: "not-allowlisted" };
    }
    return { allowed: true, owner };
  }
}
