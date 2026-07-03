/**
 * Tests for the `zero automation` removal stub (#19959, #20100).
 *
 * The automation command tree was removed with the automation -> workflow
 * migration; any invocation prints a notice pointing at `zero workflow` and
 * exits non-zero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zeroAutomationCommand } from "../automation";

describe("zero automation (removal stub)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("prints the removal notice and fails for any subcommand", async () => {
    await zeroAutomationCommand.parseAsync(
      ["automation", "create", "-n", "alerts", "--cron", "0 9 * * *"],
      { from: "user" },
    );

    expect(errorSpy).toHaveBeenCalledOnce();
    const notice = errorSpy.mock.calls[0]?.[0] as string;
    expect(notice).toContain("removed");
    expect(notice).toContain("zero workflow");
    expect(notice).toContain("zero workflow trigger add");
    expect(process.exitCode).toBe(1);
  });
});
