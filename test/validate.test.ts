import { describe, expect, it, vi } from "vitest";
import {
  buildComment,
  COMMENT_MARKER,
  CONFIG_CHECK_NAME,
  summarise,
  validateDocument,
  validatePullRequest,
} from "../src/settings/validate.js";
import { SCHEMA_MODELINE } from "../src/config/json-schema.js";
import { ConfigResolver } from "../src/config/resolver.js";
import { fakeLogger } from "../features/support/scenario.js";

describe("validateDocument", () => {
  it("reports a schema error with kind schema", () => {
    const verdict = validateDocument("woodhouse.yml", "gatekeeper:\n  enabled: definitely\n");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("schema");
  });

  it("reports invalid YAML", () => {
    const verdict = validateDocument("woodhouse.yml", "foo: [unclosed\n");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("yaml");
  });
});

const badYaml = (path: string) => ({ path, ok: false, kind: "yaml", issues: [] }) as const;

describe("summarise", () => {
  it("passes when every document is valid", () => {
    const result = summarise([{ path: "woodhouse.yml", ok: true }]);
    expect(result.conclusion).toBe("success");
  });

  it("fails and names every bad file", () => {
    const result = summarise([
      { path: "a.yml", ok: true },
      {
        path: "b.yml",
        ok: false,
        kind: "schema",
        issues: [{ path: "gatekeeper", message: "bad" }],
      },
    ]);
    expect(result.conclusion).toBe("failure");
    expect(result.title).toBe("1 configuration file invalid");
    expect(result.summary).toContain("b.yml");
    expect(result.summary).not.toContain("### `a.yml`");
  });

  it("pluralises correctly", () => {
    expect(summarise([badYaml("a"), badYaml("b")]).title).toBe("2 configuration files invalid");
  });
});

describe("buildComment", () => {
  const broken = [
    {
      path: ".github/woodhouse.yml",
      ok: false as const,
      kind: "schema" as const,
      issues: [{ path: "autoApproval.allowedActor", message: "Unrecognized key" }],
    },
  ];

  it("carries the hidden marker so it can be found again", () => {
    // Matched on the marker rather than the author, so renaming the App does
    // not orphan comments.
    expect(buildComment(broken)).toContain(COMMENT_MARKER);
  });

  it("repeats the errors inline", () => {
    const body = buildComment(broken);
    expect(body).toContain(".github/woodhouse.yml");
    expect(body).toContain("autoApproval.allowedActor");
  });

  it("offers the schema modeline so the next push is checked locally", () => {
    expect(buildComment(broken)).toContain(SCHEMA_MODELINE);
    expect(buildComment(broken)).toContain("yaml-language-server");
  });

  it("addresses the owner", () => {
    expect(buildComment(broken)).toMatch(/sir/i);
  });

  it("repeats coupling issues like any other problem", () => {
    const body = buildComment([
      {
        path: "(resolved configuration)",
        ok: false as const,
        kind: "coupling" as const,
        issues: [
          {
            path: "repository.allow_rebase_merge",
            message: "dress-code requires `allow_rebase_merge: false`; it is true.",
          },
        ],
      },
    ]);
    expect(body).toContain("(resolved configuration)");
    expect(body).toContain("`repository.allow_rebase_merge`");
    expect(body).toContain("requires `allow_rebase_merge: false`");
  });
});

describe("summarise coupling verdicts", () => {
  it("names the coupling rule and does not count it as an invalid file", () => {
    const result = summarise([
      { path: ".github/woodhouse.yml", ok: true },
      {
        path: "(resolved configuration)",
        ok: false,
        kind: "coupling",
        issues: [{ path: "repository.allow_rebase_merge", message: "not coupled" }],
      },
    ]);
    expect(result.conclusion).toBe("failure");
    expect(result.title).toBe("Dress-code merge settings are not coupled");
    expect(result.summary).toContain("Merge settings required by dress-code:");
    expect(result.summary).toContain("`repository.allow_rebase_merge`");
  });
});

type ValidateDeps = Parameters<typeof validatePullRequest>[0];

interface CheckRunParams {
  readonly name?: string;
  readonly conclusion?: string;
  readonly output?: { readonly title?: string; readonly summary?: string };
}

const LOCAL_PATH = ".github/woodhouse.yml";

const COUPLED_BASELINE = `dressCode:
  enabled: true
repository:
  allow_squash_merge: true
  squash_merge_commit_title: PR_TITLE
  allow_rebase_merge: false
  allow_merge_commit: false
`;

function makeValidationDeps(
  sources: Record<string, string>,
  changed: readonly string[] = [LOCAL_PATH],
  resolver: ValidateDeps["resolver"] = new ConfigResolver(),
) {
  const getContent = vi.fn(async (params: { repo: string; path: string }) => {
    const source = sources[`${params.repo}:${params.path}`];
    if (source === undefined) {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    return { data: { type: "file", content: Buffer.from(source, "utf8").toString("base64") } };
  });

  const createCheck = vi.fn(async (_params: CheckRunParams) => ({ data: {} }));

  const octokit = {
    pulls: {
      listFiles: vi.fn(async () => ({
        data: changed.map((filename) => ({ filename, status: "modified" })),
      })),
    },
    repos: { getContent },
    checks: { create: createCheck },
    issues: {
      listComments: vi.fn(async () => ({ data: [] })),
      createComment: vi.fn(async () => ({ data: { id: 1 } })),
      updateComment: vi.fn(async () => ({ data: { id: 1 } })),
      deleteComment: vi.fn(async () => ({ data: {} })),
    },
    paginate: vi.fn(
      async (route: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
        const { data } = await route(params);
        return data;
      },
    ),
  } as unknown as ValidateDeps["octokit"];

  const deps: ValidateDeps = { octokit, resolver, log: fakeLogger(), dryRun: false };
  return { deps, createCheck, getContent };
}

function checkSummary(createCheck: ReturnType<typeof makeValidationDeps>["createCheck"]): string {
  const params = createCheck.mock.calls[0]?.[0] as CheckRunParams | undefined;
  if (params?.output?.summary === undefined) {
    throw new Error("The check run has no output summary.");
  }
  return params.output.summary;
}

describe("validatePullRequest coupling", () => {
  it("fails the config check on coupling issues from the resolved cascade", async () => {
    const { deps, createCheck } = makeValidationDeps({
      [`widgets:${LOCAL_PATH}`]: `dressCode:
  enabled: true
repository:
  allow_rebase_merge: true
`,
    });

    const result = await validatePullRequest(deps, "acme", "widgets", 1, "headsha");

    expect(result).toBe("failure");
    const params = createCheck.mock.calls[0]?.[0] as CheckRunParams;
    expect(params.name).toBe(CONFIG_CHECK_NAME);
    expect(params.conclusion).toBe("failure");
    const summary = checkSummary(createCheck);
    expect(summary).toContain("(resolved configuration)");
    for (const path of [
      "repository.allow_squash_merge",
      "repository.squash_merge_commit_title",
      "repository.allow_rebase_merge",
      "repository.allow_merge_commit",
    ]) {
      expect(summary).toContain(`\`${path}\``);
    }
  });

  it("cannot undo the baseline's coupling from a repository file", async () => {
    const { deps, createCheck } = makeValidationDeps({
      [`.github-private:woodhouse.yml`]: COUPLED_BASELINE,
      [`widgets:${LOCAL_PATH}`]: "repository:\n  allow_rebase_merge: true\n",
    });

    const result = await validatePullRequest(deps, "acme", "widgets", 1, "headsha");

    expect(result).toBe("failure");
    const summary = checkSummary(createCheck);
    expect(summary).toContain("`repository.allow_rebase_merge`");
    expect(summary).toContain("requires `allow_rebase_merge: false`");
    // The baseline still supplies the rest of the coupling: the local override
    // must not turn them into additional failures.
    expect(summary).not.toContain("`repository.allow_squash_merge`");
    expect(summary).not.toContain("`repository.squash_merge_commit_title`");
    expect(summary).not.toContain("`repository.allow_merge_commit`");
  });

  it("resolves nothing when the pull request touches no config file", async () => {
    const resolve = vi.fn();
    const { deps, createCheck, getContent } = makeValidationDeps({}, ["README.md"], {
      resolve,
    } as unknown as ValidateDeps["resolver"]);

    const result = await validatePullRequest(deps, "acme", "widgets", 1, "headsha");

    expect(result).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(getContent).not.toHaveBeenCalled();
    expect(createCheck).not.toHaveBeenCalled();
  });

  it("keeps the invalid-file title while also listing coupling issues", async () => {
    // The resolver reads `.yml` before `.yaml`, so the `.yaml` document is
    // validated without contributing to the cascade: a schema-invalid file and
    // a coupling verdict can therefore coexist in one run.
    const { deps, createCheck } = makeValidationDeps(
      {
        [`widgets:${LOCAL_PATH}`]: `dressCode:
  enabled: true
repository:
  allow_rebase_merge: true
`,
        "widgets:.github/woodhouse.yaml": "gatekeeper:\n  enabled: definitely\n",
      },
      [LOCAL_PATH, ".github/woodhouse.yaml"],
    );

    const result = await validatePullRequest(deps, "acme", "widgets", 1, "headsha");

    expect(result).toBe("failure");
    const params = createCheck.mock.calls[0]?.[0] as CheckRunParams;
    expect(params.output?.title).toBe("1 configuration file invalid");
    const summary = checkSummary(createCheck);
    expect(summary).toContain("`.github/woodhouse.yaml`");
    expect(summary).toContain("(resolved configuration)");
    expect(summary).toContain("Merge settings required by dress-code:");
    expect(summary).toContain("`repository.allow_rebase_merge`");
  });
});
