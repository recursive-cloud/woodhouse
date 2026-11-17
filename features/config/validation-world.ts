/**
 * Fixture and harness layer for the configuration-validation acceptance suite.
 *
 * Validation reads three surfaces — the changed-file listing, the per-path
 * content fetch and the comment/check writes — so the fake octokit and the
 * scenario state it records into live here. `parseContents` maps the feature's
 * fixed `<contents>` phrases to the document they name.
 *
 * This module is not a vitest entry: `validation.steps.ts` imports it.
 */

import { vi } from "vitest";
import type { Logger } from "pino";
import { validatePullRequest } from "../../src/settings/validate.js";
import { fakeLogger, paginateFake } from "../support/scenario.js";

type Deps = Parameters<typeof validatePullRequest>[0];
type Octokit = Deps["octokit"];
type Outcome = Awaited<ReturnType<typeof validatePullRequest>>;

export const OWNER = "acme";
export const REPO = "widgets";
export const PR_NUMBER = 7;
export const HEAD_SHA = "headsha";
export const LOCAL_PATH = ".github/woodhouse.yml";

export const VALID_SOURCE = "gatekeeper:\n  strictChecks:\n    - build\n";
export const INVALID_SOURCE = "gatekeeper:\n  enabled: definitely\n";

interface ChangedFile {
  readonly filename: string;
  readonly status: string;
}

interface Comment {
  readonly id: number;
  readonly body?: string;
}

interface Blob {
  readonly type?: string;
  readonly content?: string;
}

interface ScenarioState {
  readonly files: ChangedFile[];
  readonly blobs: Record<string, Blob>;
  readonly comments: Comment[];
  dryRun: boolean;
  /** The `<contents>` cell of the last Given, for the Then step's expectations. */
  contentsCell?: string;
}

export function newScenario(): ScenarioState {
  return { files: [], blobs: {}, comments: [], dryRun: false };
}

/** Examples cells quote path-like values; strip the surrounding quotes. */
export function unquote(value: string): string {
  const text = value.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function base64(source: string): string {
  return Buffer.from(source, "utf8").toString("base64");
}

interface ValidationOctokitOptions {
  readonly state: ScenarioState;
}

/**
 * Fake octokit covering only the surfaces validation depends on: pageable
 * changed-file and comment listings, per-path content fetches, and the check
 * and comment write routes.
 */
function makeValidationOctokit({ state }: ValidationOctokitOptions) {
  const listFiles = vi.fn(async () => ({ data: state.files }));

  const getContent = vi.fn(async (params: { path: string }) => ({
    data: state.blobs[params.path] ?? { type: "file", content: base64(VALID_SOURCE) },
  }));

  const createCheck = vi.fn(async () => ({ data: {} }));

  const listComments = vi.fn(async () => ({ data: state.comments }));
  const createComment = vi.fn(async () => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async () => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  const paginate = paginateFake();

  const octokit = {
    pulls: { listFiles },
    repos: { getContent },
    checks: { create: createCheck },
    issues: { listComments, createComment, updateComment, deleteComment },
    paginate,
  } as unknown as Octokit;

  return {
    octokit,
    listFiles,
    getContent,
    createCheck,
    listComments,
    createComment,
    updateComment,
    deleteComment,
  };
}

export type Capture = ReturnType<typeof makeValidationOctokit> & {
  readonly log: Logger;
  readonly result: Outcome;
};

export async function runValidation(state: ScenarioState): Promise<Capture> {
  const fake = makeValidationOctokit({ state });
  const log = fakeLogger();
  const deps: Deps = { octokit: fake.octokit, log, dryRun: state.dryRun };
  const result = await validatePullRequest(deps, OWNER, REPO, PR_NUMBER, HEAD_SHA);
  return { ...fake, log, result };
}

interface ContentsExpectation {
  readonly source: string;
  readonly valid: boolean;
  readonly issuePath?: string;
  readonly issueMessage?: string;
}

/**
 * Map a `<contents>` cell to the settings source it names and, for an invalid
 * document, the issue path and message the runtime validator reports for it.
 * The phrases are fixed by the feature; an unrecognised one is a broken
 * scenario, so this throws instead of returning a document that might pass.
 */
export function parseContents(cell: string): ContentsExpectation {
  switch (cell.trim()) {
    case "that is a valid document":
      return { source: VALID_SOURCE, valid: true };
    case "that is an empty file":
      return { source: "", valid: true };
    case "that is a comment only":
      return { source: "# just a comment\n", valid: true };
    case "with an unknown top-level key":
      return {
        source: "gatekeper:\n  enabled: true\n",
        valid: false,
        issuePath: "(root)",
        issueMessage: "gatekeper",
      };
    case `with a misspelled "autoApproval" key`:
      return {
        source: "autoApproval:\n  allowedActor:\n    - me\n",
        valid: false,
        issuePath: "autoApproval",
        issueMessage: "allowedActor",
      };
    case `with a wrong type under "gatekeeper"`:
      return {
        source: INVALID_SOURCE,
        valid: false,
        issuePath: "gatekeeper.enabled",
        issueMessage: "expected boolean",
      };
    case `with "repository.private" set`:
      return {
        source: "repository:\n  private: true\n",
        valid: false,
        issuePath: "repository",
        issueMessage: "private",
      };
    case `with "repository.archived" set`:
      return {
        source: "repository:\n  archived: true\n",
        valid: false,
        issuePath: "repository",
        issueMessage: "archived",
      };
    case "with an out-of-range grace period":
      return {
        source: "gatekeeper:\n  gracePeriodSeconds: 99999\n",
        valid: false,
        issuePath: "gatekeeper.gracePeriodSeconds",
        issueMessage: "<=900",
      };
    default:
      throw new Error(`Unrecognised settings-file contents phrase: ${JSON.stringify(cell)}`);
  }
}

/** Record a changed settings file and the content the head fetch returns. */
export function change(
  state: ScenarioState,
  filename: string,
  source: string,
  status = "modified",
): void {
  state.files.push({ filename, status });
  state.blobs[filename] = { type: "file", content: base64(source) };
}

/** Re-point every changed (non-deleted) file at `source`. */
export function replaceAllContents(state: ScenarioState, source: string): void {
  for (const file of state.files) {
    if (file.status === "removed") continue;
    state.blobs[file.filename] = { type: "file", content: base64(source) };
  }
}
