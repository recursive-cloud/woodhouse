import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { performWrite } from "../src/lib/dry-run.js";

function fakeLogger(): Logger {
  return { info: vi.fn() } as unknown as Logger;
}

describe("performWrite", () => {
  it("skips the write and logs the label in dry-run", async () => {
    const log = fakeLogger();
    const run = vi.fn(async () => "written");

    const result = await performWrite({ dryRun: true, log }, "update repository settings", run);

    expect(run).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("DRY_RUN: would update repository settings"),
    );
  });

  it("runs the write and passes the result through on the live path", async () => {
    const log = fakeLogger();
    const run = vi.fn(async () => "written");

    const result = await performWrite({ dryRun: false, log }, "update repository settings", run);

    expect(run).toHaveBeenCalledOnce();
    expect(result).toBe("written");
    expect(log.info).not.toHaveBeenCalled();
  });
});
