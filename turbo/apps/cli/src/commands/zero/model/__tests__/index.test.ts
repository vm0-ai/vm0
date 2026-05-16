import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { zeroModelCommand } from "../index";

describe("zero model command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    mockConsoleLog.mockClear();
  });

  it("should expose workspace model-provider subcommands", () => {
    expect(zeroModelCommand.name()).toBe("model");
    expect(zeroModelCommand.description()).toBe(
      "Manage workspace model providers and BYOK settings",
    );
    expect(
      zeroModelCommand.commands.map((command) => {
        return command.name();
      }),
    ).toEqual(["list", "setup", "remove"]);
  });

  it("should point empty state users at zero model setup", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await zeroModelCommand.parseAsync(["node", "cli", "list"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("No workspace model providers configured");
    expect(logCalls).toContain("zero model setup");
    expect(logCalls).not.toContain("zero org model-provider setup");
  });
});
