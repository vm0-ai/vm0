/**
 * Tests for variable set command
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

describe("variable set command", () => {
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
    it("should create a new variable", async () => {
      server.use(
        http.put("http://localhost:3000/api/variables", () => {
          return HttpResponse.json({
            id: "1",
            name: "MY_VAR",
            value: "my-value",
            description: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await setCommand.parseAsync(["node", "cli", "MY_VAR", "my-value"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Variable "MY_VAR" saved');
      expect(logCalls).toContain("vars.MY_VAR");
    });

    it("should create a variable with description", async () => {
      server.use(
        http.put("http://localhost:3000/api/variables", async ({ request }) => {
          const body = (await request.json()) as { description?: string };
          expect(body.description).toBe("My variable description");
          return HttpResponse.json({
            id: "1",
            name: "MY_VAR",
            value: "my-value",
            description: "My variable description",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      );

      await setCommand.parseAsync([
        "node",
        "cli",
        "MY_VAR",
        "my-value",
        "-d",
        "My variable description",
      ]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain('Variable "MY_VAR" saved');
    });
  });

  describe("error handling", () => {
    it("should handle authentication error", async () => {
      server.use(
        http.put("http://localhost:3000/api/variables", () => {
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
        await setCommand.parseAsync(["node", "cli", "MY_VAR", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle validation error for invalid name", async () => {
      server.use(
        http.put("http://localhost:3000/api/variables", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  "Variable name must contain only uppercase letters, numbers, and underscores",
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
