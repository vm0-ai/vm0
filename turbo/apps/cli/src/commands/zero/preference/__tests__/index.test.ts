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
    overrides: Partial<{
      timezone: string | null;
      notifyEmail: boolean;
      notifySlack: boolean;
    }> = {},
  ) {
    return {
      timezone: null,
      notifyEmail: false,
      notifySlack: false,
      ...overrides,
    };
  }

  describe("display preferences (no flags)", () => {
    it("should display current preferences when no flags provided", async () => {
      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            defaultPreferences({
              timezone: "America/New_York",
              notifyEmail: true,
              notifySlack: false,
            }),
          );
        }),
      );

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Current preferences:");
      expect(logCalls).toContain("America/New_York");
      expect(logCalls).toContain("on");
      expect(logCalls).toContain("off");
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
      expect(logCalls).toContain("vm0 zero preference --timezone");
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
      expect(logCalls).not.toContain("vm0 zero preference --timezone");
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

  describe("--notify-email flag", () => {
    it("should enable email notifications with 'on'", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { notifyEmail?: boolean };
            expect(body.notifyEmail).toBe(true);
            return HttpResponse.json(defaultPreferences({ notifyEmail: true }));
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-email",
        "on",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Email notifications enabled");
    });

    it("should disable email notifications with 'off'", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { notifyEmail?: boolean };
            expect(body.notifyEmail).toBe(false);
            return HttpResponse.json(
              defaultPreferences({ notifyEmail: false }),
            );
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-email",
        "off",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Email notifications disabled");
    });

    it("should exit with error for invalid notify-email value", async () => {
      await expect(async () => {
        await zeroPreferenceCommand.parseAsync([
          "node",
          "cli",
          "--notify-email",
          "invalid",
        ]);
      }).rejects.toThrow("process.exit called");

      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Invalid value for --notify-email");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("--notify-slack flag", () => {
    it("should enable slack notifications with 'on'", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { notifySlack?: boolean };
            expect(body.notifySlack).toBe(true);
            return HttpResponse.json(defaultPreferences({ notifySlack: true }));
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-slack",
        "on",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack notifications enabled");
    });

    it("should disable slack notifications with 'off'", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { notifySlack?: boolean };
            expect(body.notifySlack).toBe(false);
            return HttpResponse.json(
              defaultPreferences({ notifySlack: false }),
            );
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-slack",
        "off",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack notifications disabled");
    });
  });

  describe("multiple flags", () => {
    it("should update timezone and email notifications together", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as {
              timezone?: string;
              notifyEmail?: boolean;
            };
            expect(body.timezone).toBe("Asia/Shanghai");
            expect(body.notifyEmail).toBe(true);
            return HttpResponse.json(
              defaultPreferences({
                timezone: "Asia/Shanghai",
                notifyEmail: true,
              }),
            );
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--timezone",
        "Asia/Shanghai",
        "--notify-email",
        "on",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Timezone set to");
      expect(logCalls).toContain("Asia/Shanghai");
      expect(logCalls).toContain("Email notifications enabled");
    });
  });

  describe("on/off value parsing", () => {
    it("should accept 'true' as on", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { notifyEmail?: boolean };
            expect(body.notifyEmail).toBe(true);
            return HttpResponse.json(defaultPreferences({ notifyEmail: true }));
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-email",
        "true",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Email notifications enabled");
    });

    it("should accept 'false' as off", async () => {
      server.use(
        http.post(
          "http://localhost:3000/api/zero/user-preferences",
          async ({ request }) => {
            const body = (await request.json()) as { notifyEmail?: boolean };
            expect(body.notifyEmail).toBe(false);
            return HttpResponse.json(
              defaultPreferences({ notifyEmail: false }),
            );
          },
        ),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-email",
        "false",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Email notifications disabled");
    });

    it("should accept '1' as on", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences({ notifySlack: true }));
        }),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-slack",
        "1",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack notifications enabled");
    });

    it("should accept '0' as off", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(defaultPreferences({ notifySlack: false }));
        }),
      );

      await zeroPreferenceCommand.parseAsync([
        "node",
        "cli",
        "--notify-slack",
        "0",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Slack notifications disabled");
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

      // Inject responses in order:
      // 1. "Europe/London" for timezone prompt
      // 2. false for email notification prompt
      prompts.inject(["Europe/London", false]);

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Timezone set to");
      expect(logCalls).toContain("Europe/London");
    });

    it("should prompt for email notification when disabled", async () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.get("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            defaultPreferences({ timezone: "Asia/Tokyo" }),
          );
        }),
        http.post("http://localhost:3000/api/zero/user-preferences", () => {
          return HttpResponse.json(
            defaultPreferences({ timezone: "Asia/Tokyo", notifyEmail: true }),
          );
        }),
      );

      // Timezone already set, so only email notification prompt
      prompts.inject([true]);

      await zeroPreferenceCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Email notifications enabled");
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
            defaultPreferences({
              timezone: "America/Chicago",
              notifyEmail: true,
            }),
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

      // Empty string for timezone (skip), false for email
      prompts.inject(["", false]);

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

      // Inject invalid timezone, then false for email
      prompts.inject(["Not/A/Timezone", false]);

      await expect(async () => {
        await zeroPreferenceCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      const errorCalls = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorCalls).toContain("Invalid timezone");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
