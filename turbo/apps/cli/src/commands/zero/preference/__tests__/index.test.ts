/**
 * Tests for zero preference command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, validators, formatters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroPreferenceCommand } from "../index";
import prompts from "prompts";
import chalk from "chalk";

describe("zero preference command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Save original TTY state
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();

    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  function defaultPreferences(
    overrides: Partial<{ timezone: string | null }> = {},
  ) {
    return {
      timezone: null,
      pinnedAgentIds: [],
      sendMode: "enter",
      ...overrides,
    };
  }

  describe("display preferences (no flags)", () => {
    it("should display current preferences when no flags provided", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            defaultPreferences({ timezone: "America/New_York" }),
          );
        }),
      );

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Current preferences:");
      expect(logCalls).toContain("America/New_York");
    });

    it("should show 'not set' when timezone is null", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences());
        }),
      );

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("not set");
    });

    it("should show timezone hint in non-interactive mode when timezone not set", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences());
        }),
      );

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("zero preference --timezone");
    });

    it("should not show timezone hint when timezone is already set", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            defaultPreferences({ timezone: "Asia/Shanghai" }),
          );
        }),
      );

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("zero preference --timezone");
    });
  });

  describe("--timezone flag", () => {
    it("should update timezone with a valid IANA timezone", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { timezone?: string };
            expect(body.timezone).toBe("America/New_York");
            return HttpResponse.json(
              defaultPreferences({ timezone: "America/New_York" }),
            );
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--timezone",
        "America/New_York",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Timezone set to");
      expect(logCalls).toContain("America/New_York");
    });

    it("should exit with error for invalid timezone", async () => {
      await expect(async () => {
        await zeroPreferenceCommand.parseAsync([
          "node",
          "cli",
          "--timezone",
          "Invalid/Timezone",
        ]);
      }).rejects.toThrow("process.exit called");

      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Invalid timezone: Invalid/Timezone");
      expect(errorCalls).toContain("IANA timezone identifier");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("interactive mode", () => {
    it("should prompt for timezone when not set", async () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences());
        }),
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { timezone?: string };
            expect(body.timezone).toBe("Europe/London");
            return HttpResponse.json(
              defaultPreferences({ timezone: "Europe/London" }),
            );
          },
        ),
      );

      prompts.inject(["Europe/London"]);

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Timezone set to");
      expect(logCalls).toContain("Europe/London");
    });

    it("should skip interactive prompts when all preferences are configured", async () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            defaultPreferences({ timezone: "America/Chicago" }),
          );
        }),
      );

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Current preferences:");
      // Should not prompt - no POST request expected
    });

    it("should skip timezone prompt when user enters empty value", async () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences());
        }),
      );

      prompts.inject([""]);

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("Timezone set to");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Not authenticated",
                code: "UNAUTHORIZED",
              },
            },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await zeroPreferenceCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Not authenticated");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API error when updating preferences", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Invalid timezone",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await zeroPreferenceCommand.parseAsync([
          "node",
          "cli",
          "--timezone",
          "America/New_York",
        ]);
      }).rejects.toThrow("process.exit called");

      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Invalid timezone");
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error for invalid timezone in interactive mode", async () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences());
        }),
      );

      prompts.inject(["Not/A/Timezone"]);

      await expect(async () => {
        await zeroPreferenceCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Invalid timezone");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
