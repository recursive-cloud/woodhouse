/**
 * Health route.
 *
 * Extracted from `server.ts` so tests can exercise the handler without
 * importing the module that calls `main()` at load time. It reports only the
 * liveness of this process and how many Apps it serves; it deliberately reads
 * no credentials and touches no GitHub API, since it is polled.
 */

import type { Request, Response } from "express";
import type { AppRegistry } from "./apps/registry.js";

export function handleHealth(
  _req: Request,
  res: Response,
  registry: Pick<AppRegistry, "size">,
): void {
  res.status(200).json({ status: "ok", apps: registry.size });
}
