import { describe, expect, it, vi } from "vitest";
import { ConfigResolver, type ContentsClient } from "../src/config/resolver.js";

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
  const getContent = vi.fn(
    async ({ repo, path }: { repo: string; path: string }) => {
      const key = `${repo}:${path}`;
      if (!(key in files)) throw notFound;
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(files[key]!).toString("base64"),
        },
      };
    },
  );
  return { client: { repos: { getContent } } as ContentsClient, getContent };
}

describe("ConfigResolver — cascade", () => {
  it("merges the baseline under the local config", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml":
        "gatekeeper:\n  strictChecks: [build]\nrepository:\n  has_wiki: false\n",
      "app:.github/woodhouse.yml": "repository:\n  has_issues: true\n",
    });

    const { config, sources } = await new ConfigResolver().resolve(
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
  });

  it("lets the local config win", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "repository:\n  has_wiki: true\n",
      "app:.github/woodhouse.yml": "repository:\n  has_wiki: false\n",
    });

    const { config } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(config.repository.has_wiki).toBe(false);
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

  it("falls back to defaults when nothing exists anywhere", async () => {
    const { client } = fakeClient({});
    const { config, sources } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(sources).toEqual([]);
    expect(config.settings.enabled).toBe(false);
    expect(config.gatekeeper.enabled).toBe(true);
  });

  it("accepts .yaml as well as .yml", async () => {
    const { client } = fakeClient({
      ".github-private:woodhouse.yaml": "repository:\n  has_wiki: false\n",
    });
    const { sources } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(sources).toEqual(["acme/.github-private:woodhouse.yaml"]);
  });

  it("falls back to defaults on an invalid document", async () => {
    // A broken config must not take repository settings with it.
    const { client } = fakeClient({
      "app:.github/woodhouse.yml": "gatekeeper:\n  enabled: nonsense\n",
    });
    const { config, issues } = await new ConfigResolver().resolve(
      client,
      "acme",
      "app",
      fakeLogger(),
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(config.gatekeeper.enabled).toBe(true);
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

  it("does not merge the baseline repo into itself", async () => {
    // Resolving config *for* the baseline repo would otherwise fetch the same
    // file as both layers and list it twice.
    const { client } = fakeClient({
      ".github-private:woodhouse.yml": "repository:\n  has_wiki: false\n",
    });

    const { sources } = await new ConfigResolver().resolve(
      client,
      "acme",
      ".github-private",
      fakeLogger(),
    );
    expect(sources).toEqual([]);
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
