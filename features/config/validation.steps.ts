import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import {
  COMMENT_MARKER,
  CONFIG_CHECK_NAME,
  buildComment,
  validateDocument,
} from "../../src/settings/validate.js";
import { SCHEMA_MODELINE } from "../../src/config/json-schema.js";
import {
  HEAD_SHA,
  INVALID_SOURCE,
  LOCAL_PATH,
  OWNER,
  PR_NUMBER,
  REPO,
  VALID_SOURCE,
  change,
  newScenario,
  parseContents,
  replaceAllContents,
  runValidation,
  unquote,
  type Capture,
} from "./validation-world.js";
import { readCell } from "../support/scenario.js";

const feature = await loadFeature("features/config/validation.feature");

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
