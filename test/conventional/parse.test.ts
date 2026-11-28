import { describe, expect, it } from "vitest";
import {
  CONVENTIONAL_TYPES,
  parseTitle,
  titleFailure,
  titlePatternDescription,
} from "../../src/conventional/parse.js";

describe("parseTitle", () => {
  it("parses the acceptance example", () => {
    expect(parseTitle("feat(settings): add the environments section")).toEqual({
      type: "feat",
      scope: "settings",
      breaking: false,
      subject: "add the environments section",
    });
  });

  it("rejects every acceptance failure", () => {
    for (const title of ["updated the readme", "WIP", "FIX: urgent", "feat: "]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("accepts each allowed type", () => {
    for (const type of CONVENTIONAL_TYPES) {
      expect(parseTitle(`${type}: do a thing`)).toEqual({
        type,
        breaking: false,
        subject: "do a thing",
      });
    }
  });

  it("rejects an unknown type", () => {
    for (const title of ["feature: do a thing", "fixup: do a thing", "fixing: do a thing"]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("rejects an uppercase type", () => {
    for (const title of ["FIX: urgent", "Feat: add the thing", "DOCS: explain"]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("rejects a missing colon", () => {
    for (const title of ["feat add the thing", "feat(add the thing", "feat"]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("requires the colon to be followed by a space", () => {
    expect(parseTitle("feat:add the thing")).toBeUndefined();
  });

  it("rejects an empty subject", () => {
    for (const title of ["feat:", "feat: ", "feat(settings):", "feat(settings): "]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("parses scope forms that conventional scopes use", () => {
    expect(parseTitle("fix(parser): handle null")).toMatchObject({
      type: "fix",
      scope: "parser",
    });
    expect(parseTitle("fix(schema-dress-code): split the section")).toMatchObject({
      scope: "schema-dress-code",
    });
    expect(parseTitle("fix(v1.2): patch the release")).toMatchObject({ scope: "v1.2" });
    expect(parseTitle("fix(a_b): underscore scope")).toMatchObject({ scope: "a_b" });
    expect(parseTitle("fix(a1): digits scope")).toMatchObject({ scope: "a1" });
  });

  it("rejects malformed scopes", () => {
    for (const title of [
      "fix(): empty scope",
      "fix(my scope): spaced scope",
      "fix(a)(b): two scopes",
      "fix(a/b): slash scope",
      "fix (scope): space before scope",
    ]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("parses the breaking marker with and without a scope", () => {
    expect(parseTitle("feat!: drop node 20")).toEqual({
      type: "feat",
      breaking: true,
      subject: "drop node 20",
    });
    expect(parseTitle("feat(api)!: drop node 20")).toEqual({
      type: "feat",
      scope: "api",
      breaking: true,
      subject: "drop node 20",
    });
  });

  it("rejects a breaking marker in the wrong place", () => {
    for (const title of ["feat!(api): drop node 20", "feat! : drop node 20", "feat!!: drop"]) {
      expect(parseTitle(title), title).toBeUndefined();
    }
  });

  it("does not accept surrounding whitespace", () => {
    for (const title of [
      " feat: add the thing",
      "feat: add the thing ",
      "feat:  add the thing",
      "\tfeat: add the thing",
      "feat: add the thing\n",
    ]) {
      expect(parseTitle(title), JSON.stringify(title)).toBeUndefined();
    }
  });

  it("rejects a title that carries a body", () => {
    expect(parseTitle("feat: add the thing\n\nbody text")).toBeUndefined();
  });

  it("accepts subjects with punctuation and internal spaces", () => {
    expect(parseTitle("fix(api): close issue #12 (again)")).toMatchObject({
      subject: "close issue #12 (again)",
    });
  });
});

describe("titlePatternDescription", () => {
  it("names the title shape and every allowed type", () => {
    const description = titlePatternDescription();
    expect(description).toContain("<subject>");
    for (const type of CONVENTIONAL_TYPES) {
      expect(description).toContain(type);
    }
  });
});

describe("titleFailure", () => {
  it("returns undefined for a title that matches", () => {
    expect(titleFailure("feat(settings): add the environments section")).toBeUndefined();
  });

  it("names both the expected pattern and the offending title", () => {
    const failure = titleFailure("updated the readme");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain(titlePatternDescription());
    expect(failure?.message).toContain("updated the readme");
  });
});
