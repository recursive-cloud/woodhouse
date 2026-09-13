import { describe, expect, it } from "vitest";
import { isRequestRejection } from "../src/lib/webhook-errors.js";

/**
 * These shapes are taken from what `@octokit/webhooks` actually throws, which
 * is not what its types suggest: a signature failure arrives as an
 * AggregateError wrapping an Error that carries the 400.
 */
describe("isRequestRejection", () => {
  it("recognises a wrapped signature failure", () => {
    const inner = Object.assign(
      new Error("[@octokit/webhooks] signature does not match event payload and secret"),
      { status: 400 },
    );
    const outer = Object.assign(new Error(""), {
      name: "AggregateError",
      errors: [inner],
    });

    expect(isRequestRejection(outer)).toBe(true);
  });

  it("recognises a bare signature failure", () => {
    expect(
      isRequestRejection(Object.assign(new Error("signature does not match"), { status: 400 })),
    ).toBe(true);
  });

  it("does not treat a handler failure as a rejection", () => {
    // Must be a 500 so the delivery is marked failed and can be redelivered.
    const inner = Object.assign(new Error("Integration not found"), {
      status: 404,
    });
    const outer = Object.assign(new Error(""), {
      name: "AggregateError",
      errors: [inner],
    });

    expect(isRequestRejection(outer)).toBe(false);
  });

  it("does not treat a GitHub 400 from our own API call as a rejection", () => {
    // A 400 nested under `errors` is the signature case; a plain thrown error
    // with no aggregate is our own bug.
    expect(isRequestRejection(new Error("something broke"))).toBe(false);
  });

  it("survives malformed errors", () => {
    expect(isRequestRejection(null)).toBe(false);
    expect(isRequestRejection(undefined)).toBe(false);
    expect(isRequestRejection("string")).toBe(false);
    expect(isRequestRejection({ errors: "not-an-array" })).toBe(false);
  });
});
