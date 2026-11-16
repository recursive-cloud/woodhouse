import { describe, expect, it, vi } from "vitest";
import {
  ConfigResolver,
  invalidateTouchedConfig,
  type ContentsClient,
} from "../src/config/resolver.js";
import { settingsSyncBlock } from "../src/settings/apply.js";

function fakeLogger() {
  const log: Record<string, unknown> = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  log.child = vi.fn(() => log);
  return log as never;
}

const notFound = Object.assign(new Error("Not Found"), { status: 404 });

/** Serves file contents from a `repo:path` map; 404s for anything else. */
function fakeClient(files: Record<string, string>) {
  const getContent = vi.fn(async ({ repo, path }: { repo: string; path: string }) => {
    const key = `${repo}:${path}`;
    if (!(key in files)) throw notFound;
    return {
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(files[key]!).toString("base64"),
      },
    };
  });
  return { client: { repos: { getContent } } as ContentsClient, getContent };
}

describe("ConfigResolver — cascade", () => {
  it("merges the baseline under the local config", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml":
        "gatekeeper:\n  strictChecks: [build]\nrepository:\n  has_wiki: false\n",
      "app:.github/woodhouse.yml": "repository:\n  has_issues: true\n",
    });

    const { config, sources, localSource } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );

    expect(config.gatekeeper.strictChecks).toEqual(["build"]);
    expect(config.repository.has_wiki).toBe(false);
    expect(config.repository.has_issues).toBe(true);
    expect(sources).toEqual([
      "acme/.github-private:woodhouse.yml",
      "acme/app:.github/woodhouse.yml",
    ]);
    expect(localSource).toBe("acme/app:.github/woodhouse.yml");
  });

  it("lets the local config win", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "repository:\n  has_wiki: true\n",
      "app:.github/woodhouse.yml": "repository:\n  has_wiki: false\n",
    });

    const { config } = await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());
    expect(config.repository.has_wiki).toBe(false);
  });

  it("ignores a root woodhouse.yml in a non-baseline repository", async () => {
    // Root baseline-shaped files are never a repository's local layer: the
    // owner baseline root and the local `.github/` path are the only layers. A
    // non-baseline repository's root file contributes nothing.
    const { client } = fakeClient({
      ".github-private:woodhouse.yml":
        "gatekeeper:\n  strictChecks: [build]\nrepository:\n  has_wiki: true\n",
      "app:woodhouse.yml": "settings:\n  enabled: false\nrepository:\n  has_issues: true\n",
      "app:.github/woodhouse.yml": "repository:\n  has_wiki: false\n",
    });

    const { config, sources } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );

    // Only the baseline and the `.github/` local layer contributed.
    expect(sources).toEqual([
      "acme/.github-private:woodhouse.yml",
      "acme/app:.github/woodhouse.yml",
    ]);
    expect(sources).not.toContain("acme/app:woodhouse.yml");
    // Baseline and local cascade normally...
    expect(config.gatekeeper.strictChecks).toEqual(["build"]);
    expect(config.repository.has_wiki).toBe(false);
    // ...and the ignored root file contributed nothing: its explicit false did
    // not reach the cascade, whose implicit default is now on, and its
    // repository setting never landed.
    expect(config.settings.enabled).toBe(true);
    expect(config.repository.has_issues).toBeUndefined();
  });

  it("lets a repository-level true override a baseline false", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "settings:\n  enabled: false\n",
      "app:.github/woodhouse.yml": "settings:\n  enabled: true\nrepository:\n  has_issues: true\n",
    });

    const { config, sources, localSource } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );

    // The raw layers merge before validation, so the local true is what zod
    // sees; a validated-per-layer merge would have filled the local default.
    expect(config.settings.enabled).toBe(true);
    expect(config.repository.has_issues).toBe(true);
    expect(sources).toEqual([
      "acme/.github-private:woodhouse.yml",
      "acme/app:.github/woodhouse.yml",
    ]);
    expect(localSource).toBe("acme/app:.github/woodhouse.yml");
  });

  it("keeps a baseline false when the local file does not set enabled", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "settings:\n  enabled: false\n",
      "app:.github/woodhouse.yml": "repository:\n  has_issues: true\n",
    });

    const resolved = await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());
    const { config, sources, localSource } = resolved;

    // The local file opts in, but the cascade's explicit false still silences
    // the repository: only a repo-level true overrides it.
    expect(config.settings.enabled).toBe(false);
    expect(sources).toEqual([
      "acme/.github-private:woodhouse.yml",
      "acme/app:.github/woodhouse.yml",
    ]);
    expect(localSource).toBe("acme/app:.github/woodhouse.yml");
    expect(settingsSyncBlock(resolved)).toBe("settings-disabled");
  });

  it("reports no-local-file for a baseline-only repository", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "gatekeeper:\n  strictChecks: [build]\n",
    });

    const resolved = await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());

    // The baseline contributes, but without a local file the repository never
    // opted in: the implicit enabled default must not drive a sync.
    expect(resolved.sources).toEqual(["acme/.github-private:woodhouse.yml"]);
    expect(resolved.localSource).toBeUndefined();
    expect(resolved.config.settings.enabled).toBe(true);
    expect(settingsSyncBlock(resolved)).toBe("no-local-file");
  });

  it("honours inherit: false", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "repository:\n  has_wiki: false\n",
      "app:.github/woodhouse.yml": "inherit: false\n",
    });

    const { config, sources } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(config.repository.has_wiki).toBeUndefined();
    expect(sources).toEqual(["acme/app:.github/woodhouse.yml"]);
  });

  it("honours inherit: false in the baseline repository's own .github/woodhouse.yml", async () => {
    // The root file is the baseline layer; the local file's inherit:false drops
    // it, and the local file remains the repository's opt-in.
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "repository:\n  has_wiki: false\n",
      ".github-private:.github/woodhouse.yml": "inherit: false\n",
    });

    const { config, sources, localSource } = await new ConfigResolver().resolve(
      client,
      "acme",
      ".github-private",
      fakeLogger(),
    );

    expect(config.repository.has_wiki).toBeUndefined();
    expect(sources).toEqual(["acme/.github-private:.github/woodhouse.yml"]);
    expect(localSource).toBe("acme/.github-private:.github/woodhouse.yml");
  });

  it("falls back to defaults when nothing exists anywhere", async () => {
    const { client } = fakeClient({});
    const { config, sources, localSource } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(sources).toEqual([]);
    expect(config.settings.enabled).toBe(true);
    expect(localSource).toBeUndefined();
    expect(config.gatekeeper.enabled).toBe(true);
  });

  it("accepts .yaml as well as .yml", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yaml": "repository:\n  has_wiki: false\n",
    });
    const { sources } = await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());
    expect(sources).toEqual(["acme/.github-private:woodhouse.yaml"]);
  });

  it("falls back to defaults on an invalid document", async () => {
    // A broken config must not take repository settings with it.
    const { client } = fakeClient({
      "app:.github/woodhouse.yml": "gatekeeper:\n  enabled: nonsense\n",
    });
    const { config, issues, localSource } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(config.gatekeeper.enabled).toBe(true);
    // The local file was present, so its source survives the fallback; the
    // invalid-config gate keeps this resolution from being synced.
    expect(localSource).toBe("acme/app:.github/woodhouse.yml");
  });

  it("does not treat a local file with invalid YAML as an opt-in", async () => {
    // `fetchLayer` skips a layer that fails to parse, so a broken local file is
    // not a consent signal: no local source, and the gate reports no file.
    const { client } = fakeClient({
      "app:.github/woodhouse.yml": "settings: [unclosed\n",
    });

    const resolved = await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());

    expect(resolved.sources).toEqual([]);
    expect(resolved.localSource).toBeUndefined();
    expect(settingsSyncBlock(resolved)).toBe("no-local-file");
  });
});

describe("ConfigResolver — baseline repository", () => {
  it("reads the baseline from .github-private by default", async () => {
    const { client, getContent } = fakeClient({});
    await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());

    const repos = getContent.mock.calls.map((c) => c[0].repo);
    expect(repos).toContain(".github-private");
    expect(repos).not.toContain(".github");
  });

  it("honours a configured baseline repository", async () => {
    const { client, getContent } = fakeClient({});
    await new ConfigResolver({ baselineRepo: ".github" }).resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(getContent.mock.calls.map((c) => c[0].repo)).toContain(".github");
  });

  it("resolves the baseline repository's root file as its baseline layer, not a local file", async () => {
    const { client, getContent } = fakeClient({
      ".github-private:woodhouse.yml":
        "gatekeeper:\n  strictChecks: [build]\nrepository:\n  has_wiki: false\n",
    });

    const resolved = await new ConfigResolver().resolve(
      client,
      "acme",
      ".github-private",
      fakeLogger(),
    );

    expect(resolved.config.gatekeeper.strictChecks).toEqual(["build"]);
    expect(resolved.config.repository.has_wiki).toBe(false);
    // The root file is the baseline layer; it does not opt the baseline
    // repository itself into settings management.
    expect(resolved.sources).toEqual(["acme/.github-private:woodhouse.yml"]);
    expect(resolved.localSource).toBeUndefined();
    expect(settingsSyncBlock(resolved)).toBe("no-local-file");
    // Its root file is fetched as the baseline layer, and its `.github/` paths
    // are still probed as the local layer like any other repository.
    expect(getContent.mock.calls.map((call) => [call[0].repo, call[0].path])).toEqual([
      [".github-private", "woodhouse.yml"],
      [".github-private", ".github/woodhouse.yml"],
      [".github-private", ".github/woodhouse.yaml"],
    ]);
  });

  it("manages the baseline repository through its own .github/woodhouse.yml", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "repository:\n  has_wiki: true\n",
      ".github-private:.github/woodhouse.yml":
        "settings:\n  enabled: true\nrepository:\n  has_wiki: false\n",
    });

    const resolved = await new ConfigResolver().resolve(
      client,
      "acme",
      ".github-private",
      fakeLogger(),
    );

    expect(resolved.config.settings.enabled).toBe(true);
    expect(resolved.config.repository.has_wiki).toBe(false);
    expect(resolved.sources).toEqual([
      "acme/.github-private:woodhouse.yml",
      "acme/.github-private:.github/woodhouse.yml",
    ]);
    expect(resolved.localSource).toBe("acme/.github-private:.github/woodhouse.yml");
    expect(settingsSyncBlock(resolved)).toBeNull();
  });

  it("resolves a custom baseline repo's own root file as its baseline layer", async () => {
    const { client, getContent } = fakeClient({
      ".github:woodhouse.yml": "settings:\n  enabled: true\n",
    });

    const resolved = await new ConfigResolver({ baselineRepo: ".github" }).resolve(
      client,
      "acme",
      ".github",
      fakeLogger(),
    );

    expect(resolved.config.settings.enabled).toBe(true);
    expect(resolved.sources).toEqual(["acme/.github:woodhouse.yml"]);
    expect(resolved.localSource).toBeUndefined();
    expect(settingsSyncBlock(resolved)).toBe("no-local-file");
    expect(getContent.mock.calls.map((call) => call[0].path)).toContain(".github/woodhouse.yml");
  });

  it("falls back to defaults when the baseline repo has no root configuration", async () => {
    const { client } = fakeClient({});

    const { config, sources, localSource } = await new ConfigResolver().resolve(
      client,
      "acme",
      ".github-private",
      fakeLogger(),
    );

    expect(sources).toEqual([]);
    expect(config.settings.enabled).toBe(true);
    expect(localSource).toBeUndefined();
  });

  it("identifies the baseline repo case-insensitively", () => {
    const resolver = new ConfigResolver();
    expect(resolver.isBaselineRepo(".GitHub-Private")).toBe(true);
    expect(resolver.isBaselineRepo(".github")).toBe(false);
  });
});

describe("ConfigResolver — caching", () => {
  it("does not refetch within the TTL", async () => {
    const { client, getContent } = fakeClient({});
    const resolver = new ConfigResolver();

    await resolver.resolve(client, "acme", "app", fakeLogger());
    const first = getContent.mock.calls.length;
    await resolver.resolve(client, "acme", "app", fakeLogger());

    expect(getContent.mock.calls.length).toBe(first);
  });

  it("refetches after invalidate", async () => {
    const { client, getContent } = fakeClient({});
    const resolver = new ConfigResolver();

    await resolver.resolve(client, "acme", "app", fakeLogger());
    const first = getContent.mock.calls.length;
    resolver.invalidate("acme", "app");
    await resolver.resolve(client, "acme", "app", fakeLogger());

    expect(getContent.mock.calls.length).toBeGreaterThan(first);
  });

  it("invalidateOwner clears every repo for that owner", async () => {
    // A baseline change affects every repository, not just the one pushed to.
    const { client, getContent } = fakeClient({});
    const resolver = new ConfigResolver();

    await resolver.resolve(client, "acme", "one", fakeLogger());
    await resolver.resolve(client, "acme", "two", fakeLogger());
    const before = getContent.mock.calls.length;

    resolver.invalidateOwner("acme");
    await resolver.resolve(client, "acme", "one", fakeLogger());
    await resolver.resolve(client, "acme", "two", fakeLogger());

    expect(getContent.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not leak between owners", async () => {
    const { client, getContent } = fakeClient({});
    const resolver = new ConfigResolver();

    await resolver.resolve(client, "acme", "app", fakeLogger());
    const before = getContent.mock.calls.length;
    await resolver.resolve(client, "other", "app", fakeLogger());

    expect(getContent.mock.calls.length).toBeGreaterThan(before);
  });
});

/** Minimal structural stand-in for the resolver's invalidation surface. */
function fakeResolver(isBaseline: boolean) {
  return {
    isBaselineRepo: vi.fn(() => isBaseline),
    invalidate: vi.fn(),
    invalidateOwner: vi.fn(),
  };
}

describe("invalidateTouchedConfig", () => {
  it("invalidates owner-wide when the baseline repository is touched", () => {
    const resolver = fakeResolver(true);

    expect(invalidateTouchedConfig(resolver, "acme", ".github-private")).toBe("owner");
    expect(resolver.invalidateOwner).toHaveBeenCalledWith("acme");
    expect(resolver.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates only the repository otherwise", () => {
    const resolver = fakeResolver(false);

    expect(invalidateTouchedConfig(resolver, "acme", "app")).toBe("repo");
    expect(resolver.invalidate).toHaveBeenCalledWith("acme", "app");
    expect(resolver.invalidateOwner).not.toHaveBeenCalled();
  });
});
