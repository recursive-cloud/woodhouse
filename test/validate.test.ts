import { describe, expect, it } from "vitest";
import {
  buildComment,
  COMMENT_MARKER,
  isConfigPath,
  summarise,
  validateDocument,
} from "../src/settings/validate.js";
import { SCHEMA_MODELINE } from "../src/config/json-schema.js";

describe("isConfigPath", () => {
  it.each([".github/woodhouse.yml", ".github/woodhouse.yaml", "woodhouse.yml", "woodhouse.yaml"])(
    "recognises %s",
    (path) => {
      expect(isConfigPath(path)).toBe(true);
    },
  );

  it.each(["src/woodhouse.yml", "README.md", ".github/dependabot.yml"])("ignores %s", (path) => {
    expect(isConfigPath(path)).toBe(false);
  });
});

describe("validateDocument", () => {
  it("accepts a valid document", () => {
    const verdict = validateDocument(
      "woodhouse.yml",
      "gatekeeper:\n  strictChecks:\n    - build\n",
    );
    expect(verdict.ok).toBe(true);
  });

  it("accepts an empty document as inherit-everything", () => {
    expect(validateDocument("woodhouse.yml", "").ok).toBe(true);
    expect(validateDocument("woodhouse.yml", "# just a comment\n").ok).toBe(true);
  });

  it("reports invalid YAML", () => {
    const verdict = validateDocument("woodhouse.yml", "foo: [unclosed\n");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("yaml");
  });

  it("reports a schema error with a usable path", () => {
    const verdict = validateDocument("woodhouse.yml", "gatekeeper:\n  enabled: definitely\n");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("schema");
    expect(verdict.issues[0]?.path).toBe("gatekeeper.enabled");
  });

  it("catches a misspelled key rather than ignoring it", () => {
    const verdict = validateDocument("woodhouse.yml", "autoApproval:\n  allowedActor:\n    - me\n");
    expect(verdict.ok).toBe(false);
  });

  it("rejects settings that cannot be managed safely", () => {
    // `private` and `archived` are not in the schema on purpose.
    expect(validateDocument("woodhouse.yml", "repository:\n  private: true\n").ok).toBe(false);
    expect(validateDocument("woodhouse.yml", "repository:\n  archived: true\n").ok).toBe(false);
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
});
