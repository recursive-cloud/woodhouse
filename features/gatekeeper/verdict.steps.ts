import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import {
  evaluate,
  type CheckRunLike,
  type Evaluation,
  type Outcome,
} from "../../src/gatekeeper/evaluate.js";
import { gatekeeperSchema, type GatekeeperConfig } from "../../src/config/schema.js";
import { WHITE_GLOVE_CHECK_NAME } from "../../src/gatekeeper/constants.js";
import { readCell } from "../support/scenario.js";

const feature = await loadFeature("features/gatekeeper/verdict.feature");

/**
 * Name a check from a phrase. The feature spells our own check by its literal
 * name; the literal is required to match the feature text, so map it onto the
 * exported constant here.
 */
function resolveCheckName(raw: string): string {
  return raw === "woodhouse/white-glove" ? WHITE_GLOVE_CHECK_NAME : raw;
}

/**
 * Build one check run from a phrase such as `only "build" failing` or
 * `"ci/unit" passing started "2024-01-01T00:00:00Z" id 100`.
 *
 * The phrases are fixed by the feature; an unrecognised phrase is a broken
 * scenario, so this throws instead of returning a run that might pass.
 */
function parseCheckPhrase(phrase: string): CheckRunLike {
  let text = phrase.trim();
  if (text.startsWith("only ")) {
    text = text.slice("only ".length).trim();
  }

  // Attempt metadata is a suffix on an otherwise ordinary status phrase.
  let startedAt: string | undefined;
  let id: number | undefined;
  const metadata = /^(.*) started "([^"]+)" id (\d+)$/.exec(text);
  if (metadata !== null) {
    text = (metadata[1] as string).trim();
    startedAt = metadata[2] as string;
    id = Number(metadata[3]);
  }

  const run = (name: string, status: string, conclusion: string | null): CheckRunLike => ({
    name: resolveCheckName(name),
    status,
    conclusion,
    ...(id === undefined ? {} : { id }),
    ...(startedAt === undefined ? {} : { startedAt }),
  });

  const passing = /^"([^"]+)" passing$/.exec(text);
  if (passing !== null) {
    return run(passing[1] as string, "completed", "success");
  }

  const failing = /^"([^"]+)" failing$/.exec(text);
  if (failing !== null) {
    return run(failing[1] as string, "completed", "failure");
  }

  const reporting = /^"([^"]+)" reporting "([^"]+)"$/.exec(text);
  if (reporting !== null) {
    return run(reporting[1] as string, "completed", reporting[2] as string);
  }

  const stillRunning = /^"([^"]+)" still running$/.exec(text);
  if (stillRunning !== null) {
    return run(stillRunning[1] as string, "in_progress", null);
  }

  const skipped = /^"([^"]+)" skipped$/.exec(text);
  if (skipped !== null) {
    return run(skipped[1] as string, "completed", "skipped");
  }

  const neutral = /^"([^"]+)" neutral$/.exec(text);
  if (neutral !== null) {
    return run(neutral[1] as string, "completed", "neutral");
  }

  const completedWithoutConclusion = /^"([^"]+)" completed without a conclusion$/.exec(text);
  if (completedWithoutConclusion !== null) {
    return run(completedWithoutConclusion[1] as string, "completed", null);
  }

  throw new Error(`Unrecognised check phrase: ${JSON.stringify(phrase)}`);
}

/** Build the head commit's check runs from a `<checks>` cell. */
function parseChecks(cell: string): CheckRunLike[] {
  // Not quote-aware: a name containing " and " would mis-split, so the fragments throw in parseCheckPhrase and it fails closed.
  const phrases = cell.split(" and ").map((phrase) => phrase.trim());
  if (phrases.some((phrase) => phrase === "")) {
    throw new Error(`Malformed checks cell: ${JSON.stringify(cell)}`);
  }
  return phrases.map(parseCheckPhrase);
}

/** Read a quoted check name cell such as `"build"`. */
function parseCheckNameCell(cell: string): string {
  const match = /^"([^"]+)"$/.exec(cell.trim());
  if (match === null) {
    throw new Error(`Unrecognised check name cell: ${JSON.stringify(cell)}`);
  }
  return match[1] as string;
}

/** Map a `<outcome>` cell to the domain outcome it names. */
function parseOutcome(cell: string): Outcome {
  switch (cell.trim()) {
    case "passes":
      return "success";
    case "reports failure":
      return "failure";
    case "stays pending":
      return "pending";
    default:
      throw new Error(`Unrecognised outcome phrase: ${JSON.stringify(cell)}`);
  }
}

/** Build the real gatekeeper config, letting the schema apply its defaults. */
function buildConfig(
  strictChecks: readonly string[] = [],
  ignoredChecks: readonly string[] = [],
): GatekeeperConfig {
  return gatekeeperSchema.parse({ strictChecks, ignoredChecks });
}

function requireChecks(checks: readonly CheckRunLike[] | undefined): readonly CheckRunLike[] {
  if (checks === undefined) {
    throw new Error("The head commit's checks have not been built yet.");
  }
  return checks;
}

function requireEvaluation(evaluation: Evaluation | undefined): Evaluation {
  if (evaluation === undefined) {
    throw new Error("The white-glove verdict has not been evaluated yet.");
  }
  return evaluation;
}

describeFeature(feature, ({ ScenarioOutline }) => {
  ScenarioOutline(
    `A check's conclusion decides the consolidated verdict`,
    ({ Given, When, Then }, variables) => {
      let checks: CheckRunLike[] | undefined;
      let evaluation: Evaluation | undefined;

      Given(`the head commit carries the checks <checks>`, () => {
        checks = parseChecks(readCell(variables, "checks"));
      });
      When(`the white-glove verdict is evaluated`, () => {
        evaluation = evaluate(requireChecks(checks), buildConfig());
      });
      Then(`the consolidated verdict <outcome>`, () => {
        expect(requireEvaluation(evaluation).outcome).toBe(
          parseOutcome(readCell(variables, "outcome")),
        );
      });
    },
  );

  ScenarioOutline(
    `A strict check must report success explicitly`,
    ({ Given, When, Then, And }, variables) => {
      let strictChecks: string[] = [];
      let checks: CheckRunLike[] | undefined;
      let evaluation: Evaluation | undefined;

      Given(`gatekeeper.strictChecks lists <strict>`, () => {
        strictChecks = [parseCheckNameCell(readCell(variables, "strict"))];
      });
      And(`the head commit carries the checks <checks>`, () => {
        checks = parseChecks(readCell(variables, "checks"));
      });
      When(`the white-glove verdict is evaluated`, () => {
        evaluation = evaluate(requireChecks(checks), buildConfig(strictChecks));
      });
      Then(`the consolidated verdict <outcome>`, () => {
        expect(requireEvaluation(evaluation).outcome).toBe(
          parseOutcome(readCell(variables, "outcome")),
        );
      });
    },
  );

  ScenarioOutline(`Strictness beats the ignore list`, ({ Given, When, Then, And }, variables) => {
    let strictChecks: string[] = [];
    let ignoredChecks: string[] = [];
    let checks: CheckRunLike[] | undefined;
    let evaluation: Evaluation | undefined;

    Given(`gatekeeper.strictChecks lists "build"`, () => {
      strictChecks = ["build"];
    });
    And(`gatekeeper.ignoredChecks lists "build"`, () => {
      ignoredChecks = ["build"];
    });
    And(`the head commit carries the checks <checks>`, () => {
      checks = parseChecks(readCell(variables, "checks"));
    });
    When(`the white-glove verdict is evaluated`, () => {
      evaluation = evaluate(requireChecks(checks), buildConfig(strictChecks, ignoredChecks));
    });
    Then(`the consolidated verdict <outcome>`, () => {
      expect(requireEvaluation(evaluation).outcome).toBe(
        parseOutcome(readCell(variables, "outcome")),
      );
    });
  });

  ScenarioOutline(
    `An ignored check is excluded from the verdict`,
    ({ Given, When, Then, And }, variables) => {
      let ignoredChecks: string[] = [];
      let checks: CheckRunLike[] | undefined;
      let evaluation: Evaluation | undefined;

      Given(`gatekeeper.ignoredChecks lists "coverage"`, () => {
        ignoredChecks = ["coverage"];
      });
      And(`the head commit carries the checks <checks>`, () => {
        checks = parseChecks(readCell(variables, "checks"));
      });
      When(`the white-glove verdict is evaluated`, () => {
        evaluation = evaluate(requireChecks(checks), buildConfig([], ignoredChecks));
      });
      Then(`the consolidated verdict <outcome>`, () => {
        expect(requireEvaluation(evaluation).outcome).toBe(
          parseOutcome(readCell(variables, "outcome")),
        );
      });
    },
  );

  ScenarioOutline(
    `Same-named runs collapse to their latest attempt`,
    ({ Given, When, Then }, variables) => {
      let checks: CheckRunLike[] | undefined;
      let evaluation: Evaluation | undefined;

      Given(`the head commit carries the checks <checks>`, () => {
        checks = parseChecks(readCell(variables, "checks"));
      });
      When(`the white-glove verdict is evaluated`, () => {
        evaluation = evaluate(requireChecks(checks), buildConfig());
      });
      Then(`the consolidated verdict <outcome>`, () => {
        expect(requireEvaluation(evaluation).outcome).toBe(
          parseOutcome(readCell(variables, "outcome")),
        );
      });
    },
  );
});
