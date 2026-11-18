import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import type { AppRegistry } from "../src/apps/registry.js";
import { handleHealth } from "../src/health.js";

/** Records the status and body the handler writes, without a socket. */
function fakeResponse(): {
  res: Response;
  status: () => number | undefined;
  body: () => unknown;
} {
  let statusCode: number | undefined;
  let responseBody: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      responseBody = payload;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => responseBody };
}

/** The only registry surface the handler reads. */
function registryOfSize(size: number): Pick<AppRegistry, "size"> {
  return { size };
}

const req = {} as Request;

describe("handleHealth", () => {
  it("reports 200 with an ok status and the number of apps", () => {
    const response = fakeResponse();

    handleHealth(req, response.res, registryOfSize(2));

    expect(response.status()).toBe(200);
    expect(response.body()).toEqual({ status: "ok", apps: 2 });
  });

  it("reports zero apps for an empty registry", () => {
    const response = fakeResponse();

    handleHealth(req, response.res, registryOfSize(0));

    expect(response.body()).toEqual({ status: "ok", apps: 0 });
  });
});
