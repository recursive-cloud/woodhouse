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

  it("accepts .yaml as well as .yml", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yaml": "repository:\n  has_wiki: false\n",
    });
    const { sources } = await new ConfigResolver().resolve(client, "acme", "app", fakeLogger());
    expect(sources).toEqual(["acme/.github-private:woodhouse.yaml"]);
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
