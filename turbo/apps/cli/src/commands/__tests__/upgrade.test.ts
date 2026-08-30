import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";

import { upgradeCommand } from "../upgrade";

describe("okou upgrade command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("prints the plan link recognized by web chat", async () => {
    await upgradeCommand.parseAsync(["node", "cli", "pro"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Upgrade to Pro");
    expect(output).toContain(
      "http://localhost:3000/?settings=billing&billingView=plans",
    );
  });
});
