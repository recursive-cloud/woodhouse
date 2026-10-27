import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { defaultConfig, type WoodhouseConfig } from "../src/config/schema.js";
import { handleOnboarding, type OnboardingDeps } from "../src/onboarding/handler.js";
import {
  ONBOARDING_BRANCH,
  ONBOARDING_FILE_PATH,
  ONBOARDING_LABEL,
  ONBOARDING_PR_BODY,
  ONBOARDING_PR_TITLE,
  ONBOARDING_TEMPLATE,
} from "../src/onboarding/wording.js";

interface FakeConfig {
  /** Settings paths that exist: an exact path, or `repo:path`, for any repository. */
  presentPaths?: readonly string[];
  /** Return an open onboarding pull request from `pulls.list`. */
  openOnboardingPr?: boolean;
  /** Repositories whose `repos.get` has no default branch (empty repository). */
  emptyRepos?: readonly string[];
  /** A repository whose onboarding branch already exists (`git.getRef` succeeds). */
  branchExistsRepos?: readonly string[];
  /** `pulls.create` rejects with a 403 for this repository, after the probes. */
  failCreateForRepo?: string;
  /** A read probe (`repos.getContent`) rejects with a 403 for this repository. */
  forbiddenReadForRepo?: string;
  /** Repositories `apps.listReposAccessibleToInstallation` reports, page by page. */
  accessibleRepos?: ReadonlyArray<{ readonly name?: unknown } | null>;
  /** Enumeration rejects (the installation endpoint refuses). */
  enumerationFails?: boolean;
}

/**
 * Recording fake octokit.
 *
 * Every method the handler could reach pushes its name (with the repository and
 * path where relevant) onto `calls` in invocation order — reads included — so
 * "skipped silently" and "cheap-first" are literal assertions over the whole
 * surface, not just the writes. Behaviour is configured per test rather than
 * re-implemented per test, keeping the recording intact.
 */
function fakeOctokit(config: FakeConfig = {}) {
  const calls: string[] = [];

  const present = (repo: string, path: string): boolean =>
    (config.presentPaths ?? []).some((entry) => entry === path || entry === `${repo}:${path}`);

  const getContent = vi.fn(async ({ repo, path }: { repo: string; path: string }) => {
    calls.push(`repos.getContent ${repo}:${path}`);
    if (config.forbiddenReadForRepo === repo) {
      // A read-only installation can be refused its read permission too; the
      // refusal happens before any write would have been attempted.
      throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
    }
    if (present(repo, path)) return { data: { type: "file", content: "c2V0dGluZ3M6IHt9" } };
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });

  const get = vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`repos.get ${repo}`);
    const empty = (config.emptyRepos ?? []).includes(repo);
    return { data: { default_branch: empty ? "" : "main" } };
  });

  const getRef = vi.fn(async ({ repo, ref }: { repo: string; ref: string }) => {
    calls.push(`git.getRef ${repo}:${ref}`);
    if (ref.includes(ONBOARDING_BRANCH)) {
      if ((config.branchExistsRepos ?? []).includes(repo)) {
        return { data: { object: { sha: "existing-onboarding-sha" } } };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    return { data: { object: { sha: "base-sha" } } };
  });

  const list = vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`pulls.list ${repo}`);
    if (!config.openOnboardingPr) return { data: [] };
    return { data: [{ number: 9, labels: [{ name: ONBOARDING_LABEL }] }] };
  });

  const createRef = vi.fn(async () => {
    calls.push("git.createRef");
    return { data: {} };
  });

  const createOrUpdateFileContents = vi.fn(async () => {
    calls.push("repos.createOrUpdateFileContents");
    return { data: {} };
  });

  const create = vi.fn(async ({ repo }: { repo: string }) => {
    calls.push(`pulls.create ${repo}`);
    if (config.failCreateForRepo === repo) {
      throw Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
      });
    }
    return { data: { number: 42 } };
  });

  const addLabels = vi.fn(async () => {
    calls.push("issues.addLabels");
    return { data: [] };
  });

  const listReposAccessibleToInstallation = vi.fn(
    async (params: { per_page?: number; page?: number } = {}) => {
      const perPage = params.per_page ?? 30;
      const page = params.page ?? 1;
      calls.push(`apps.listReposAccessibleToInstallation page=${page} per_page=${perPage}`);
      if (config.enumerationFails) {
        throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
      }
      const all = config.accessibleRepos ?? [];
      return {
        data: {
          total_count: all.length,
          repositories: all.slice((page - 1) * perPage, page * perPage),
        },
      };
    },
  );

  /**
   * Mirrors `octokit.paginate` for the installation endpoint: it calls the
   * method once per page with the caller's params, reads the `repositories`
   * array (a `total_count` response is not itself the list), and stops on a
   * short page. A real multi-page batch therefore needs real iteration here
   * rather than a stub that hands back everything at once.
   */
  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
      params: Record<string, unknown> = {},
    ) => {
      const perPage = typeof params.per_page === "number" ? params.per_page : 30;
      const items: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const { data } = await route({ ...params, page });
        const batch = Array.isArray(data)
          ? data
          : ((data as { repositories?: unknown[] }).repositories ?? []);
        items.push(...batch);
        if (batch.length < perPage) break;
      }
      return items;
    },
  );

  const octokit = {
    repos: { getContent, get, createOrUpdateFileContents },
    git: { getRef, createRef },
    pulls: { list, create },
    issues: { addLabels },
    apps: { listReposAccessibleToInstallation },
    paginate,
  } as unknown as OnboardingDeps["octokit"];

  return {
    octokit,
    calls,
    getContent,
    get,
    getRef,
    list,
    createRef,
    createOrUpdateFileContents,
    create,
    addLabels,
    listReposAccessibleToInstallation,
    paginate,
  };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function build(
  config: FakeConfig = {},
  dryRun = false,
  resolveConfig?: OnboardingDeps["resolveConfig"],
) {
  const fake = fakeOctokit(config);
  const log = fakeLogger();
  const resolve = resolveConfig ?? vi.fn(async () => defaultConfig());
  const deps: OnboardingDeps = {
    octokit: fake.octokit,
    log: log as unknown as Logger,
    dryRun,
    resolveConfig: resolve,
  };

  return { ...fake, log, deps, resolveConfig: resolve };
}

/** Defaults with the settings master switch set, as a baseline resolution would. */
function configWithSettingsEnabled(enabled: boolean): WoodhouseConfig {
  const config = defaultConfig();
  config.settings.enabled = enabled;
  return config;
}

/** `installation` `created` payload carrying the freshly installed repositories. */
const created = (...names: string[]) => ({
  action: "created",
  installation: { repositories: names.map((name) => ({ name })) },
});

/** `installation_repositories` `added` payload. */
const added = (...names: string[]) => ({
  action: "added",
  repositories_added: names.map((name) => ({ name })),
});

const OWNER = "acme";

describe("handleOnboarding", () => {
  it("opens the onboarding pull request on a fresh install, probes then writes in order", async () => {
    const {
      deps,
      calls,
      getContent,
      get,
      list,
      createRef,
      create,
      createOrUpdateFileContents,
      addLabels,
    } = build();

    await handleOnboarding(deps, OWNER, created("widgets"));

    // Cheap-first: the four settings paths, 404 for each, then the open-offer
    // search, then the write facts — only after all of them does the seam run.
    expect(calls).toEqual([
      `repos.getContent widgets:.github/woodhouse.yml`,
      `repos.getContent widgets:.github/woodhouse.yaml`,
      `repos.getContent widgets:woodhouse.yml`,
      `repos.getContent widgets:woodhouse.yaml`,
      "pulls.list widgets",
      "repos.get widgets",
      `git.getRef widgets:heads/main`,
      `git.getRef widgets:heads/${ONBOARDING_BRANCH}`,
      "git.createRef",
      "repos.createOrUpdateFileContents",
      "pulls.create widgets",
      "issues.addLabels",
    ]);

    expect(getContent).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenCalledWith({
      owner: OWNER,
      repo: "widgets",
      state: "open",
      head: `${OWNER}:${ONBOARDING_BRANCH}`,
    });
    expect(get).toHaveBeenCalledWith({ owner: OWNER, repo: "widgets" });

    expect(createRef).toHaveBeenCalledWith({
      owner: OWNER,
      repo: "widgets",
      ref: `refs/heads/${ONBOARDING_BRANCH}`,
      sha: "base-sha",
    });

    const contentsArg = createOrUpdateFileContents.mock.calls[0]![0] as {
      content: string;
    };
    expect(Buffer.from(contentsArg.content, "base64").toString("utf8")).toBe(ONBOARDING_TEMPLATE);

    expect(create).toHaveBeenCalledWith({
      owner: OWNER,
      repo: "widgets",
      title: ONBOARDING_PR_TITLE,
      head: ONBOARDING_BRANCH,
      base: "main",
      body: ONBOARDING_PR_BODY,
    });
    expect(addLabels).toHaveBeenCalledWith({
      owner: OWNER,
      repo: "widgets",
      issue_number: 42,
      labels: [ONBOARDING_LABEL],
    });
  });

  it("skips an already-configured repository without ever searching for a pull request", async () => {
    // A root-level baseline path: the two `.github/` locals must be probed and
    // found absent before the baseline-shaped path is reached.
    const { deps, calls, list, createRef, createOrUpdateFileContents, create, addLabels, log } =
      build({ presentPaths: ["woodhouse.yml"] });

    await handleOnboarding(deps, OWNER, created("widgets"));

    // All the probes that ran, and nothing more. Crucially no `pulls.list`.
    expect(calls).toEqual([
      "repos.getContent widgets:.github/woodhouse.yml",
      "repos.getContent widgets:.github/woodhouse.yaml",
      "repos.getContent widgets:woodhouse.yml",
    ]);
    expect(list).not.toHaveBeenCalled();

    // No writes at all.
    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();

    // "Silently" means no pull request, not no log: the machine-readable reason
    // is recorded for the operator.
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: "widgets",
        reason: "settings-file-present",
      }),
      "Onboarding skipped",
    );
  });

  it("skips a re-delivery while the onboarding pull request is open", async () => {
    const { deps, calls, list, createRef, createOrUpdateFileContents, create, addLabels, log } =
      build({ openOnboardingPr: true });

    await handleOnboarding(deps, OWNER, created("widgets"));

    expect(list).toHaveBeenCalledOnce();
    expect(calls).toContain("pulls.list widgets");

    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "widgets",
        reason: "onboarding-pull-request-open",
      }),
      "Onboarding skipped",
    );
  });

  it("skips a repository the owner baseline manages, without searching for a pull request", async () => {
    const resolveConfig = vi.fn(async () => configWithSettingsEnabled(true));
    const { deps, calls, list, createRef, createOrUpdateFileContents, create, addLabels, log } =
      build({}, false, resolveConfig);

    await handleOnboarding(deps, OWNER, created("widgets"));

    // The management check ran after the four settings probes and short-circuited
    // before the open-offer search: no `pulls.list`.
    expect(resolveConfig).toHaveBeenCalledWith(OWNER, "widgets");
    expect(calls).toEqual([
      "repos.getContent widgets:.github/woodhouse.yml",
      "repos.getContent widgets:.github/woodhouse.yaml",
      "repos.getContent widgets:woodhouse.yml",
      "repos.getContent widgets:woodhouse.yaml",
    ]);
    expect(list).not.toHaveBeenCalled();
    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: "widgets",
        reason: "baseline-managed",
      }),
      "Onboarding skipped",
    );
  });

  it("still offers a repository whose resolved configuration has settings disabled", async () => {
    const resolveConfig = vi.fn(async () => configWithSettingsEnabled(false));
    const { deps, list, create, addLabels } = build({}, false, resolveConfig);

    await handleOnboarding(deps, OWNER, created("widgets"));

    expect(resolveConfig).toHaveBeenCalledWith(OWNER, "widgets");
    expect(list).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "widgets" }));
    expect(addLabels).toHaveBeenCalledOnce();
  });

  it("fails closed when configuration resolution rejects, then walks the next repository", async () => {
    const resolveConfig = vi.fn(async (_owner: string, repo: string) => {
      if (repo === "alpha") throw new Error("network unavailable");
      return configWithSettingsEnabled(false);
    });
    const { deps, calls, create, log } = build({}, false, resolveConfig);

    await handleOnboarding(deps, OWNER, created("alpha", "beta"));

    // Alpha's failure is logged as that repository's error; no offer, no PR search.
    expect(calls).not.toContain("pulls.list alpha");
    expect(calls).not.toContain("pulls.create alpha");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, repo: "alpha" }),
      expect.stringContaining("network unavailable"),
    );

    // The walk continued and beta was offered normally.
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "beta" }));
  });

  it("fails closed when the baseline parses but fails validation, without an offer", async () => {
    // The wrapper in app.ts maps a resolution with non-empty `issues` to
    // undefined; the handler must treat that as unresolvable, never as the
    // resolver's fallback defaults (which would offer the repository).
    const resolveConfig = vi.fn(async (_owner: string, repo: string) =>
      repo === "alpha" ? undefined : configWithSettingsEnabled(false),
    );
    const { deps, calls, create, log } = build({}, false, resolveConfig);

    await handleOnboarding(deps, OWNER, created("alpha", "beta"));

    expect(calls).not.toContain("pulls.list alpha");
    expect(calls).not.toContain("pulls.create alpha");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, repo: "alpha" }),
      expect.stringContaining("Could not resolve woodhouse configuration for acme/alpha"),
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "beta" }));
  });

  it("issues no pull request search for a managed repository while probing the others", async () => {
    const resolveConfig = vi.fn(async (_owner: string, repo: string) =>
      configWithSettingsEnabled(repo === "managed"),
    );
    const { deps, calls, create, addLabels } = build({}, false, resolveConfig);

    await handleOnboarding(deps, OWNER, created("managed", "free"));

    expect(calls).not.toContain("pulls.list managed");
    expect(calls).toContain("pulls.list free");
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "free" }));
    expect(addLabels).toHaveBeenCalledOnce();
  });

  it("does not resolve configuration for a repository that already has a settings file", async () => {
    const resolveConfig = vi.fn(async () => configWithSettingsEnabled(false));
    const { deps } = build({ presentPaths: ["woodhouse.yml"] }, false, resolveConfig);

    await handleOnboarding(deps, OWNER, created("widgets"));

    expect(resolveConfig).not.toHaveBeenCalled();
  });

  it("offers onboarding for a repository added to an existing installation", async () => {
    const { deps, create, addLabels, log } = build();

    await handleOnboarding(deps, OWNER, added("gadgets"));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "gadgets" }));
    expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ repo: "gadgets" }));
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "gadgets", pullRequestNumber: 42 }),
      "Onboarding offer complete",
    );
  });

  it("enumerates the installation's repositories when a fresh install carries no list", async () => {
    // The empty name and the null entry are dropped by the same filter the
    // payload path uses; the two real repositories are walked as any batch.
    const { deps, paginate, listReposAccessibleToInstallation, create, addLabels } = build({
      accessibleRepos: [{ name: "alpha" }, { name: "" }, null, { name: "beta" }],
    });

    await handleOnboarding(deps, OWNER, { action: "created" });

    expect(paginate).toHaveBeenCalledWith(listReposAccessibleToInstallation, { per_page: 100 });
    expect(create.mock.calls.map((call) => (call[0] as { repo: string }).repo)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(addLabels).toHaveBeenCalledTimes(2);
  });

  it("walks every page of an enumeration that spans more than one page", async () => {
    const names = Array.from({ length: 150 }, (_, index) => `repo-${index}`);
    const { deps, calls, listReposAccessibleToInstallation, create } = build({
      accessibleRepos: names.map((name) => ({ name })),
    });

    await handleOnboarding(deps, OWNER, { action: "created" });

    // `per_page: 100` over 150 names needs two requests, and the second page is
    // walked rather than truncated.
    expect(listReposAccessibleToInstallation).toHaveBeenCalledTimes(2);
    expect(calls).toContain("apps.listReposAccessibleToInstallation page=1 per_page=100");
    expect(calls).toContain("apps.listReposAccessibleToInstallation page=2 per_page=100");

    const offered = create.mock.calls.map((call) => (call[0] as { repo: string }).repo);
    expect(offered).toHaveLength(150);
    expect(new Set(offered).size).toBe(150);
    expect(offered[0]).toBe("repo-0");
    expect(offered[149]).toBe("repo-149");
  });

  it("logs one error and writes nothing when enumeration fails", async () => {
    const { deps, calls, create, createRef, createOrUpdateFileContents, addLabels, log } = build({
      enumerationFails: true,
    });

    await expect(handleOnboarding(deps, OWNER, { action: "created" })).resolves.toBeUndefined();

    // Enumeration is the delivery's only call: no repository was probed and
    // nothing was written.
    expect(calls).toEqual(["apps.listReposAccessibleToInstallation page=1 per_page=100"]);
    expect(create).not.toHaveBeenCalled();
    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, action: "created" }),
      expect.stringContaining(
        "Could not enumerate the repositories accessible to the installation",
      ),
    );
    // The old "carried no repository list" info line is replaced by the error.
    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("no repository list"),
    );
  });

  it("enumerates in dry-run and writes nothing", async () => {
    const { deps, paginate, createRef, createOrUpdateFileContents, create, addLabels, log } = build(
      { accessibleRepos: [{ name: "alpha" }] },
      true,
    );

    await handleOnboarding(deps, OWNER, { action: "created" });

    // The read-only enumeration happened and the would-be offer was logged.
    expect(paginate).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ branch: ONBOARDING_BRANCH, file: ONBOARDING_FILE_PATH }),
      expect.stringContaining("DRY_RUN: would open onboarding pull request"),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "alpha", dryRun: true, pullRequestNumber: null }),
      "Onboarding offer complete",
    );

    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
  });

  it("re-enumerates on a re-delivery without opening a second offer", async () => {
    const { deps, paginate, create, addLabels, log } = build({
      accessibleRepos: [{ name: "alpha" }],
      openOnboardingPr: true,
    });

    await handleOnboarding(deps, OWNER, { action: "created" });
    await handleOnboarding(deps, OWNER, { action: "created" });

    // The second delivery enumerated again and the open-offer probe absorbed it.
    expect(paginate).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "alpha", reason: "onboarding-pull-request-open" }),
      "Onboarding skipped",
    );
  });

  it("in dry-run probes everything and writes nothing", async () => {
    const {
      deps,
      calls,
      getContent,
      get,
      getRef,
      list,
      createRef,
      createOrUpdateFileContents,
      create,
      addLabels,
      log,
    } = build({}, true);

    await handleOnboarding(deps, OWNER, created("widgets"));

    // The decision was evaluated in full — every read happened.
    expect(getContent).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(getRef).toHaveBeenCalledTimes(2);

    // Not one write, and the would-be pull request is logged.
    expect(calls.filter((call) => call.startsWith("git.createRef"))).toEqual([]);
    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(addLabels).not.toHaveBeenCalled();

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: ONBOARDING_BRANCH,
        file: ONBOARDING_FILE_PATH,
        title: ONBOARDING_PR_TITLE,
        body: ONBOARDING_PR_BODY,
      }),
      expect.stringContaining("DRY_RUN: would open onboarding pull request"),
    );
  });

  it("is a no-op for actions other than created and added", async () => {
    const { deps, calls, log } = build();

    await handleOnboarding(deps, OWNER, {
      action: "deleted",
      installation: { repositories: [{ name: "widgets" }] },
    });
    await handleOnboarding(deps, OWNER, {
      action: "removed",
      repositories_added: [{ name: "widgets" }],
    });

    expect(calls).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("walks multiple repositories strictly sequentially", async () => {
    const { deps, calls, create, addLabels } = build();

    await handleOnboarding(deps, OWNER, created("alpha", "beta"));

    // Every one of alpha's calls precedes every one of beta's.
    const alphaFirst = calls.indexOf("repos.getContent alpha:.github/woodhouse.yml");
    const alphaLast = calls.lastIndexOf("pulls.create alpha");
    const betaFirst = calls.indexOf("repos.getContent beta:.github/woodhouse.yml");
    expect(alphaLast).toBeLessThan(betaFirst);
    expect(alphaFirst).toBeLessThan(alphaLast);

    expect(create.mock.calls.map((call) => (call[0] as { repo: string }).repo)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(addLabels).toHaveBeenCalledTimes(2);
  });

  it("logs a write failure on one repository and still walks the next", async () => {
    const { deps, calls, create, addLabels, log } = build({
      failCreateForRepo: "alpha",
    });

    await handleOnboarding(deps, OWNER, created("alpha", "beta"));

    // Alpha's probes and writes ran, its pull request failed, and beta still
    // got its full walk.
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((call) => (call[0] as { repo: string }).repo)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(addLabels).toHaveBeenCalledOnce();
    expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ repo: "beta" }));

    // Alpha's ref and contents still happened before the pull request failed.
    expect(calls).toContain("git.createRef");
    expect(calls).toContain("repos.createOrUpdateFileContents");

    // The 403 gets the actionable hint naming the missing write permissions.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, repo: "alpha" }),
      expect.stringContaining('"contents: write" and "pull_requests: write"'),
    );
  });

  it("qualifies the 403 hint when the refusal is on a read, not a write", async () => {
    const { deps, calls, create, log } = build({
      forbiddenReadForRepo: "widgets",
    });

    await handleOnboarding(deps, OWNER, created("widgets"));

    // The very first read probe was refused; no write was ever attempted.
    expect(create).not.toHaveBeenCalled();
    expect(calls).toEqual(["repos.getContent widgets:.github/woodhouse.yml"]);

    // The hint stays honest: it names reads as well as writes, and does not
    // present itself as an unqualified write failure.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, repo: "widgets" }),
      expect.stringContaining("read permissions"),
    );
    const message = log.error.mock.calls[0]?.[1] as string;
    expect(message).not.toContain("write forbidden");
  });

  it("enumerates for any acted-on delivery with an empty or missing list", async () => {
    const { deps, calls, paginate, create, log } = build();

    // The known GitHub shape for an all-repositories install omits the list;
    // the access-switch shape can carry an empty one. Both are list-less
    // acted-on deliveries and both enumerate.
    await handleOnboarding(deps, OWNER, { action: "created" });
    await handleOnboarding(deps, OWNER, { action: "created", installation: { repositories: [] } });
    await handleOnboarding(deps, OWNER, { action: "added", repositories_added: [] });

    expect(paginate).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([
      "apps.listReposAccessibleToInstallation page=1 per_page=100",
      "apps.listReposAccessibleToInstallation page=1 per_page=100",
      "apps.listReposAccessibleToInstallation page=1 per_page=100",
    ]);

    // An empty enumeration is not an error and opens no offers.
    expect(create).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("treats a malformed payload as no repositories rather than throwing", async () => {
    const { deps, calls, log } = build();

    await expect(handleOnboarding(deps, OWNER, null)).resolves.toBeUndefined();
    await expect(handleOnboarding(deps, OWNER, "not-an-object")).resolves.toBeUndefined();
    await expect(handleOnboarding(deps, OWNER, undefined)).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("catches an empty repository's facts failure and walks the next repository", async () => {
    const { deps, create, addLabels, log } = build({ emptyRepos: ["alpha"] });

    await handleOnboarding(deps, OWNER, created("alpha", "beta"));

    // Alpha threw on the facts probe (no default branch) and was logged; beta
    // still got its offer.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, repo: "alpha" }),
      expect.stringContaining("has no default branch"),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repo: "beta" }));
    expect(addLabels).toHaveBeenCalledOnce();
  });

  it("opens from an existing branch without rewriting it when the branch already exists", async () => {
    const { deps, calls, createRef, createOrUpdateFileContents, create } = build({
      branchExistsRepos: ["widgets"],
    });

    await handleOnboarding(deps, OWNER, created("widgets"));

    expect(createRef).not.toHaveBeenCalled();
    expect(createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(calls).toContain("pulls.create widgets");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ head: ONBOARDING_BRANCH, base: "main" }),
    );
  });
});
