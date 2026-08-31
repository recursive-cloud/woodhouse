import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config/schema.js";

/**
 * The shipped example is the first thing anyone copies. If the schema changes
 * and the example is not updated, this fails rather than handing out a config
 * that the app will reject at runtime.
 */
describe("woodhouse.example.yml", () => {
  it("validates against the schema", () => {
    const path = fileURLToPath(
      new URL("../woodhouse.example.yml", import.meta.url),
    );
    const result = parseConfig(yaml.load(readFileSync(path, "utf8")));

    if (!result.ok) console.error(result.issues);
    expect(result.ok).toBe(true);
  });
});
