import { describe, expect, it } from "vitest";
import { approvalBody } from "../src/approval/wording.js";

const SIGN_OFF = "_Woodhouse, at your service._";

describe("approvalBody", () => {
  it("builds the exact owner body, ending with the sign-off", () => {
    expect(approvalBody("owner", "my-user")).toBe(
      "Very good, sir. Approving on your behalf — this pull request touches no protected paths.\n\n" +
        SIGN_OFF,
    );
  });

  it("builds the exact bot body, naming the author", () => {
    expect(approvalBody("bot", "renovate[bot]")).toBe(
      "Sir, just letting you know I am letting the handyman in to fix a few things — " +
        "renovate[bot] asked to be merged and this pull request touches no protected paths.\n\n" +
        SIGN_OFF,
    );
  });

  it("keeps the author's original casing", () => {
    expect(approvalBody("bot", "Renovate[Bot]")).toContain("Renovate[Bot] asked to be merged");
  });

  it("always ends with the service sign-off", () => {
    expect(approvalBody("owner", "my-user").endsWith(SIGN_OFF)).toBe(true);
    expect(approvalBody("bot", "renovate[bot]").endsWith(SIGN_OFF)).toBe(true);
  });

  it("tailors owner and bot bodies differently", () => {
    expect(approvalBody("owner", "renovate[bot]")).not.toBe(approvalBody("bot", "renovate[bot]"));
  });
});
