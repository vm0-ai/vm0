import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";

import { zeroUpgradeCommand } from "../upgrade";

describe("zero upgrade command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("prints the plan link recognized by web chat", async () => {
    await zeroUpgradeCommand.parseAsync(["node", "cli", "pro"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Upgrade to Pro");
    expect(output).toContain(
      "http://localhost:3000/?settings=billing&billingView=plans",
    );
  });
});
