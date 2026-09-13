/**
 * JSON Schema for `woodhouse.yml`, derived from the zod definitions.
 *
 * Generated rather than hand-written so the two cannot drift: if they
 * disagreed, an editor would bless a configuration the bot then rejects, which
 * is worse than having no schema at all. CI regenerates and diffs against the
 * committed copy — see `npm run schema:check`.
 */

import { z } from "zod";
import { woodhouseConfigSchema } from "./schema.js";

const REPO = "recursive-cloud/woodhouse";

/** Where editors should fetch the schema from. */
export const SCHEMA_URL = `https://raw.githubusercontent.com/${REPO}/main/schema/woodhouse.schema.json`;

/** Path of the committed copy, relative to the repository root. */
export const SCHEMA_FILE = "schema/woodhouse.schema.json";

/** The modeline that makes editors pick the schema up automatically. */
export const SCHEMA_MODELINE = `# yaml-language-server: $schema=${SCHEMA_URL}`;

export function buildJsonSchema(): string {
  const schema = z.toJSONSchema(woodhouseConfigSchema, {
    // "input" matters: in output mode every field carrying a default is
    // reported as required, so an editor would flag a perfectly valid minimal
    // config as missing dozens of keys.
    io: "input",
  });

  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URL,
    title: "Woodhouse configuration",
    description:
      "Configuration for the Woodhouse GitHub App. Place at " +
      "`.github/woodhouse.yml` in a repository, or `woodhouse.yml` in the " +
      "owner's `.github-private` repository to set an owner-wide baseline.",
    ...schema,
  };

  // Trailing newline so the file diffs cleanly and satisfies POSIX tooling.
  return `${JSON.stringify(document, null, 2)}\n`;
}
