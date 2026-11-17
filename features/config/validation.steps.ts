import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { Logger } from "pino";
import {
  COMMENT_MARKER,
  CONFIG_CHECK_NAME,
  buildComment,
  validateDocument,
  validatePullRequest,
} from "../../src/settings/validate.js";
import { SCHEMA_MODELINE } from "../../src/config/json-schema.js";
import { fakeLogger, readCell } from "../support/scenario.js";

const feature = await loadFeature("features/config/validation.feature");

type Deps = Parameters<typeof validatePullRequest>[0];
type Octokit = Deps["octokit"];
type Outcome = Awaited<ReturnType<typeof validatePullRequest>>;
const OWNER = "acme";
const REPO = "widgets";
const PR_NUMBER = 7;
const HEAD_SHA = "headsha";
const LOCAL_PATH = ".github/woodhouse.yml";

const VALID_SOURCE = "gatekeeper:\n  strictChecks:\n    - build\n";
const INVALID_SOURCE = "gatekeeper:\n  enabled: definitely\n";

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

function newScenario(): ScenarioState {
  return { files: [], blobs: {}, comments: [], dryRun: false };
}

/** Examples cells quote path-like values; strip the surrounding quotes. */
function unquote(value: string): string {
  const text = value.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function base64(source: string): string {
  return Buffer.from(source, "utf8").toString("base64");
}

/**
 * Fake octokit covering only the surfaces validation depends on: pageable
 * changed-file and comment listings, per-path content fetches, and the check
 * and comment write routes. `paginate` mirrors octokit by calling the route once.
 */
function fakeOctokit(state: ScenarioState) {
  const listFiles = vi.fn(async () => ({ data: state.files }));

  const getContent = vi.fn(async (params: { path: string }) => ({
    data: state.blobs[params.path] ?? { type: "file", content: base64(VALID_SOURCE) },
  }));

  const createCheck = vi.fn(async () => ({ data: {} }));

  const listComments = vi.fn(async () => ({ data: state.comments }));
  const createComment = vi.fn(async () => ({ data: { id: 1 } }));
  const updateComment = vi.fn(async () => ({ data: { id: 1 } }));
  const deleteComment = vi.fn(async () => ({ data: {} }));

  const paginate = vi.fn(
    async (
      route: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
      params: Record<string, unknown>,
    ) => {
      const { data } = await route({ ...params, page: 1 });
      return data;
    },
  );

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

type Capture = ReturnType<typeof fakeOctokit> & {
  readonly log: Logger;
  readonly result: Outcome;
};

async function runValidation(state: ScenarioState): Promise<Capture> {
  const fake = fakeOctokit(state);
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
function parseContents(cell: string): ContentsExpectation {
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
function change(state: ScenarioState, filename: string, source: string, status = "modified"): void {
  state.files.push({ filename, status });
  state.blobs[filename] = { type: "file", content: base64(source) };
}

/** Re-point every changed (non-deleted) file at `source`. */
function replaceAllContents(state: ScenarioState, source: string): void {
  for (const file of state.files) {
    if (file.status === "removed") continue;
    state.blobs[file.filename] = { type: "file", content: base64(source) };
  }
}

describeFeature(feature, ({ ScenarioOutline, Scenario }) => {
  ScenarioOutline(`Pull request adds a local config`, ({ Given, When, Then }, variables) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request that adds <path>`, () => {
      change(state, unquote(readCell(variables, "path")), VALID_SOURCE, "added");
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`the file at the pull request head is validated`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      const file = state.files[0];
      if (file === undefined) throw new Error("The scenario defined no changed file.");
      expect(capture.getContent).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        path: file.filename,
        ref: HEAD_SHA,
      });
    });
  });

  ScenarioOutline(`Baseline config pull request`, ({ Given, When, Then }, variables) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request on the baseline repository that changes <path>`, () => {
      change(state, unquote(readCell(variables, "path")), VALID_SOURCE);
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`the file at the pull request head is validated`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      const file = state.files[0];
      if (file === undefined) throw new Error("The scenario defined no changed file.");
      expect(capture.getContent).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        path: file.filename,
        ref: HEAD_SHA,
      });
    });
  });

  ScenarioOutline(`Near-miss filename`, ({ Given, When, Then }, variables) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request that changes only <path>`, () => {
      change(state, unquote(readCell(variables, "path")), VALID_SOURCE);
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`no settings file is treated as changed and no validation runs`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.getContent).not.toHaveBeenCalled();
      expect(capture.createCheck).not.toHaveBeenCalled();
      expect(capture.listComments).not.toHaveBeenCalled();
      expect(capture.createComment).not.toHaveBeenCalled();
      expect(capture.updateComment).not.toHaveBeenCalled();
      expect(capture.deleteComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`Deletion is not validated`, ({ Given, When, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request whose only settings change deletes ".github/woodhouse.yml"`, () => {
      state.files.push({ filename: LOCAL_PATH, status: "removed" });
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`no "woodhouse/config" check is posted for it`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.getContent).not.toHaveBeenCalled();
      expect(capture.createCheck).not.toHaveBeenCalled();
    });
  });

  ScenarioOutline(`Non-regular file is not validated`, ({ Given, When, Then }, variables) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request that replaces ".github/woodhouse.yml" with a <kind>`, () => {
      const kind = readCell(variables, "kind").trim();
      if (kind !== "symlink" && kind !== "submodule") {
        throw new Error(`Unrecognised non-regular file kind: ${JSON.stringify(kind)}`);
      }
      state.files.push({ filename: LOCAL_PATH, status: "modified" });
      state.blobs[LOCAL_PATH] = { type: kind };
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`no "woodhouse/config" check is posted for it`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.getContent).toHaveBeenCalled();
      expect(capture.createCheck).not.toHaveBeenCalled();
    });
  });

  ScenarioOutline(`Valid configuration`, ({ Given, When, Then }, variables) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request changing a settings file <contents>`, () => {
      const cell = readCell(variables, "contents");
      change(state, LOCAL_PATH, parseContents(cell).source);
      state.contentsCell = cell;
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`the "woodhouse/config" check reports success`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.createCheck).toHaveBeenCalledOnce();
      expect(capture.createCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          name: CONFIG_CHECK_NAME,
          head_sha: HEAD_SHA,
          conclusion: "success",
        }),
      );
    });
  });

  ScenarioOutline(`Invalid configuration`, ({ Given, When, Then }, variables) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request changing a settings file <contents>`, () => {
      const cell = readCell(variables, "contents");
      change(state, LOCAL_PATH, parseContents(cell).source);
      state.contentsCell = cell;
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`the "woodhouse/config" check reports failure with the issue paths and messages`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      const cell = state.contentsCell;
      if (cell === undefined) throw new Error("The settings-file contents have not been set yet.");
      const expected = parseContents(cell);
      if (expected.issuePath === undefined || expected.issueMessage === undefined) {
        throw new Error(`The scenario expects a failing document, but "${cell}" is valid.`);
      }

      expect(capture.createCheck).toHaveBeenCalledOnce();
      expect(capture.createCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          name: CONFIG_CHECK_NAME,
          conclusion: "failure",
          output: expect.objectContaining({
            summary: expect.stringContaining(`\`${expected.issuePath}\``),
          }),
        }),
      );
      expect(capture.createCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({
            summary: expect.stringContaining(expected.issueMessage),
          }),
        }),
      );
      expect(capture.createCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({ summary: expect.stringContaining(LOCAL_PATH) }),
        }),
      );
    });
  });

  Scenario(`Comment explains and suggests`, ({ Given, When, And, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request changing a settings file with a wrong type under "gatekeeper"`, () => {
      const cell = `with a wrong type under "gatekeeper"`;
      change(state, LOCAL_PATH, parseContents(cell).source);
      state.contentsCell = cell;
    });
    And(`no comment on the pull request yet`, () => {
      state.comments.length = 0;
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`one comment lists the issues and suggests adding the schema modeline to the file`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      const cell = state.contentsCell;
      if (cell === undefined) throw new Error("The settings-file contents have not been set yet.");
      const expected = parseContents(cell);
      if (expected.issuePath === undefined)
        throw new Error("The scenario expects a failing document.");

      expect(capture.createComment).toHaveBeenCalledOnce();
      expect(capture.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: PR_NUMBER,
          body: expect.stringContaining(COMMENT_MARKER),
        }),
      );
      expect(capture.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining(LOCAL_PATH) }),
      );
      expect(capture.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining(`\`${expected.issuePath}\``) }),
      );
      expect(capture.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining(SCHEMA_MODELINE) }),
      );
      expect(capture.updateComment).not.toHaveBeenCalled();
      expect(capture.deleteComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`Next push fixes the file`, ({ Given, When, And, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request carrying the marker comment from an earlier push`, () => {
      change(state, LOCAL_PATH, INVALID_SOURCE);
      state.contentsCell = `with a wrong type under "gatekeeper"`;
      state.comments.push({ id: 10, body: "a human comment" });
      state.comments.push({
        id: 42,
        body: buildComment([validateDocument(LOCAL_PATH, INVALID_SOURCE)]),
      });
    });
    And(`a later push that makes every settings file validate`, () => {
      replaceAllContents(state, VALID_SOURCE);
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`the comment is deleted`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.deleteComment).toHaveBeenCalledOnce();
      expect(capture.deleteComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 42 }),
      );
      expect(capture.createComment).not.toHaveBeenCalled();
      expect(capture.updateComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`Re-delivery does not duplicate`, ({ Given, When, And, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request carrying the marker comment from an earlier push`, () => {
      change(state, LOCAL_PATH, INVALID_SOURCE);
      state.contentsCell = `with a wrong type under "gatekeeper"`;
      state.comments.push({ id: 10, body: "a human comment" });
      state.comments.push({
        id: 42,
        body: buildComment([validateDocument(LOCAL_PATH, INVALID_SOURCE)]),
      });
    });
    And(`the settings file still fails validation`, () => {
      replaceAllContents(state, INVALID_SOURCE);
      state.contentsCell = `with a wrong type under "gatekeeper"`;
    });
    When(`the same pull request event re-delivers`, async () => {
      capture = await runValidation(state);
    });
    Then(`the existing comment is updated in place, never duplicated`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.listComments).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          issue_number: PR_NUMBER,
          per_page: 100,
        }),
      );
      expect(capture.updateComment).toHaveBeenCalledOnce();
      expect(capture.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 42 }),
      );
      expect(capture.createComment).not.toHaveBeenCalled();
      expect(capture.deleteComment).not.toHaveBeenCalled();
    });
  });

  Scenario(`Valid from the start`, ({ Given, When, And, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`a pull request whose settings files all validate`, () => {
      change(state, LOCAL_PATH, VALID_SOURCE);
    });
    And(`no comment on the pull request yet`, () => {
      state.comments.length = 0;
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`no comment is left and the "woodhouse/config" check passes`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.createComment).not.toHaveBeenCalled();
      expect(capture.updateComment).not.toHaveBeenCalled();
      expect(capture.deleteComment).not.toHaveBeenCalled();
      expect(capture.createCheck).toHaveBeenCalledWith(
        expect.objectContaining({ conclusion: "success" }),
      );
    });
  });

  Scenario(`Dry-run validation`, ({ Given, When, And, Then }) => {
    const state = newScenario();
    let capture: Capture | undefined;

    Given(`dry-run mode is on`, () => {
      state.dryRun = true;
    });
    And(`a pull request changing a settings file with a wrong type under "gatekeeper"`, () => {
      const cell = `with a wrong type under "gatekeeper"`;
      change(state, LOCAL_PATH, parseContents(cell).source);
      state.contentsCell = cell;
    });
    When(`the configuration validation runs`, async () => {
      capture = await runValidation(state);
    });
    Then(`GitHub receives no comment and no check run`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.createCheck).not.toHaveBeenCalled();
      expect(capture.createComment).not.toHaveBeenCalled();
      expect(capture.updateComment).not.toHaveBeenCalled();
      expect(capture.deleteComment).not.toHaveBeenCalled();
      expect(capture.listComments).not.toHaveBeenCalled();
    });
    And(`each suppressed check and comment write is logged as a skipped write`, () => {
      if (capture === undefined) throw new Error("The configuration validation has not run yet.");
      expect(capture.log.info).toHaveBeenCalledTimes(2);
      expect(capture.log.info).toHaveBeenCalledWith(
        expect.stringContaining("DRY_RUN: would write config validation check"),
      );
      expect(capture.log.info).toHaveBeenCalledWith(
        expect.stringContaining("DRY_RUN: would sync comment"),
      );
    });
  });
});
