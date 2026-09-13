/**
 * Writes the committed JSON Schema. Run via `npm run schema:generate`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildJsonSchema, SCHEMA_FILE } from "../src/config/json-schema.js";

const target = resolve(process.cwd(), SCHEMA_FILE);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, buildJsonSchema());
process.stdout.write(`Wrote ${SCHEMA_FILE}\n`);
