/**
 * Fail if the committed JSON Schema no longer matches the zod definitions.
 *
 * Deliberately not `git diff`-based: that reports nothing for an untracked
 * file, so a schema that had never been committed would pass silently.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildJsonSchema, SCHEMA_FILE } from "../src/config/json-schema.js";

const target = resolve(process.cwd(), SCHEMA_FILE);

let committed: string;
try {
  committed = readFileSync(target, "utf8");
} catch {
  process.stderr.write(
    `${SCHEMA_FILE} is missing. Run \`npm run schema:generate\`.\n`,
  );
  process.exit(1);
}

if (committed !== buildJsonSchema()) {
  process.stderr.write(
    `${SCHEMA_FILE} is out of date with src/config/schema.ts.\n` +
      "Run `npm run schema:generate` and commit the result.\n",
  );
  process.exit(1);
}

process.stdout.write(`${SCHEMA_FILE} is up to date\n`);
