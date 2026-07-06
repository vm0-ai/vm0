/**
 * Tests for the `zero schedule` removal stub (#17307, #20100).
 *
 * The schedule command tree was removed; any invocation prints a notice
 * pointing at `zero workflow` and exits non-zero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zeroScheduleCommand } from "../schedule";

describe("zero schedule (removal stub)", () => {
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
    await zeroScheduleCommand.parseAsync(
      ["schedule", "setup", "my-agent", "--frequency", "daily"],
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
