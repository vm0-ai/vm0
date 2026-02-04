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
import chalk from "chalk";

describe("secret set command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("successful set", () => {
    it("should create a new secret", async () => {
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
        "secret-value",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" saved');
      expect(logCalls).toContain("secrets.MY_API_KEY");
    });

    it("should create a secret with description", async () => {
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
        "secret-value",
        "-d",
        "My API key",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Secret "MY_API_KEY" saved');
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
        await setCommand.parseAsync(["node", "cli", "MY_API_KEY", "value"]);
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
        await setCommand.parseAsync(["node", "cli", "invalid-name", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("must contain only uppercase"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
