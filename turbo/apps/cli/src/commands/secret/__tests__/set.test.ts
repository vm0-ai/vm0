/**
 * Tests for secret set command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { setCommand } from "../set";
import prompts from "prompts";
import chalk from "chalk";

describe("secret set command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.unstubAllEnvs();

    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  describe("--body flag", () => {
    it("should create a new secret with --body", async () => {
      server.use(
        http.put("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_API_KEY",
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await setCommand.parseAsync([
        "node",
        "cli",
        "MY_API_KEY",
        "--body",
        "secret-value",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" saved');
      expect(logCalls).toContain("secrets.MY_API_KEY");
    });

    it("should create a secret with -b short flag", async () => {
      server.use(
        http.put("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_API_KEY",
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await setCommand.parseAsync([
        "node",
        "cli",
        "MY_API_KEY",
        "-b",
        "secret-value",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" saved');
    });

    it("should create a secret with --body and --description", async () => {
      server.use(
        http.put("http://localhost:3000/api/secrets", async ({ request }) => {
          const body = (await request.json()) as { description?: string };
          expect(body.description).toBe("My API key");
          return HttpResponse.json({
            id: "1",
            name: "MY_API_KEY",
            description: "My API key",
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await setCommand.parseAsync([
        "node",
        "cli",
        "MY_API_KEY",
        "--body",
        "secret-value",
        "-d",
        "My API key",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" saved');
    });
  });

  describe("interactive mode", () => {
    it("should prompt for secret value in interactive mode", async () => {
      // Set TTY to true for interactive mode
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.put("http://localhost:3000/api/secrets", async ({ request }) => {
          const body = (await request.json()) as { value: string };
          expect(body.value).toBe("interactive-secret-value");
          return HttpResponse.json({
            id: "1",
            name: "MY_API_KEY",
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      // Inject the password response
      prompts.inject(["interactive-secret-value"]);

      await setCommand.parseAsync(["node", "cli", "MY_API_KEY"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" saved');
    });

    it("should create secret with interactive input and description", async () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });

      server.use(
        http.put("http://localhost:3000/api/secrets", async ({ request }) => {
          const body = (await request.json()) as {
            value: string;
            description?: string;
          };
          expect(body.value).toBe("my-secret");
          expect(body.description).toBe("Test description");
          return HttpResponse.json({
            id: "1",
            name: "TEST_SECRET",
            description: "Test description",
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      prompts.inject(["my-secret"]);

      await setCommand.parseAsync([
        "node",
        "cli",
        "TEST_SECRET",
        "-d",
        "Test description",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "TEST_SECRET" saved');
    });
  });

  describe("non-interactive mode", () => {
    it("should error when no --body provided in non-interactive mode", async () => {
      // Tests run in non-interactive environment (no TTY)
      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY_API_KEY"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--body is required in non-interactive mode"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show usage hint in error message", async () => {
      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY_API_KEY"]);
      }).rejects.toThrow("process.exit called");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("vm0 secret set MY_API_KEY --body");
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.put("http://localhost:3000/api/secrets", () => {
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
        await setCommand.parseAsync([
          "node",
          "cli",
          "MY_API_KEY",
          "--body",
          "value",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle validation error for invalid name", async () => {
      server.use(
        http.put("http://localhost:3000/api/secrets", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Secret name must contain only uppercase letters, numbers, and underscores",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await setCommand.parseAsync([
          "node",
          "cli",
          "invalid-name",
          "--body",
          "value",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must contain only uppercase"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
