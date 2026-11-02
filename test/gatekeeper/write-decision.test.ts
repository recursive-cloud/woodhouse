import { describe, expect, it } from "vitest";
import { resolveCheckWrite } from "../../src/gatekeeper/write-decision.js";
import type { Outcome } from "../../src/gatekeeper/evaluate.js";

describe("resolveCheckWrite", () => {
  describe("no existing run", () => {
    it.each<Outcome>(["pending", "success", "failure"])("creates for a %s outcome", (outcome) => {
      expect(resolveCheckWrite(undefined, outcome)).toBe("create");
    });
  });

  describe("existing run is not completed", () => {
    it.each(["queued", "in_progress", "waiting", "requested", "a-status-github-may-add"])(
      "updates a %s run",
      (status) => {
        expect(resolveCheckWrite({ status }, "pending")).toBe("update");
      },
    );
  });

  describe("existing run is completed", () => {
    it.each<Outcome>(["success", "failure"])("updates for a terminal %s outcome", (outcome) => {
      expect(resolveCheckWrite({ status: "completed" }, outcome)).toBe("update");
    });

    it("creates for a pending outcome", () => {
      expect(resolveCheckWrite({ status: "completed" }, "pending")).toBe("create");
    });
  });
});
